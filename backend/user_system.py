"""
用户系统核心模块

- 账户数据 / 邀请码 / 每账户 API Key 以「整体加密文件」存储于 data/users 下：
    1) 文件级加密：整个 JSON 序列化后加密写盘，磁盘上为密文
    2) 字段级加密：密码哈希串、API Key、邮箱、邀请码在解密后的 JSON 内仍为密文
    （双保险，见 crypto.write_json_enc / read_json_enc）
- 三级权限：最高级管理员(admin) > 管理员(manager) > 用户(user)
- 邀请码：一级→管理员，二级→用户，一次性作废，带过期时间
- 用户管理：延长 / 清除 / 级联删除（admin 清除 manager 时其下 user 同步清除）
- 同一公司账号共享同一映射库（公司隔离由 mapping_history 处理）
- 旧版 backend/users 数据在启动时自动迁移到 data/users 并转为加密文件
"""

import os
import uuid
import hashlib
import shutil
import secrets
import threading
from datetime import datetime, timedelta

from config import USERS_DIR, LEGACY_USERS_DIR, DATA_DIR
from crypto import (
    encrypt, decrypt, hash_password, verify_password,
    read_json_enc, write_json_enc,
)

# 数据文件
USERS_FILE = os.path.join(USERS_DIR, "users.json")
INVITES_FILE = os.path.join(USERS_DIR, "invite_codes.json")
APIKEYS_FILE = os.path.join(USERS_DIR, "api_keys.json")
# 公司数据库注册表：公司名 → 加密的公司数据库密码（映射库隔离凭证）
COMPANIES_FILE = os.path.join(USERS_DIR, "companies.json")

_lock = threading.RLock()

# 角色
ROLE_ADMIN = "admin"
ROLE_MANAGER = "manager"
ROLE_USER = "user"
ROLES = (ROLE_ADMIN, ROLE_MANAGER, ROLE_USER)

# 内置最高级管理员：用户名固定，口令与公司信息优先取环境变量，
# 未设置时随机生成（仅在首次初始化时使用，并在启动日志中打印一次）。
SUPER_ADMIN_USERNAME = "admin"
SUPER_ADMIN_PASSWORD = os.environ.get("TC_ADMIN_PASSWORD") or secrets.token_urlsafe(12)
SUPER_ADMIN_COMPANY = os.environ.get("TC_ADMIN_COMPANY") or "默认公司"
# 内置公司初始数据库密码：仅用于全新系统首次创建 admin 时的公司初始化，
# admin 可随时在「用户管理 → 公司数据库密码」中修改；存量公司迁移时使用随机密码。
SUPER_ADMIN_COMPANY_DB_PWD = os.environ.get("TC_ADMIN_COMPANY_DB_PWD") or secrets.token_urlsafe(12)

# 游客登录：无密码临时账号，退出登录（或令牌过期 / 服务重启）后自动清除全部使用痕迹
GUEST_USERNAME_PREFIX = "__guest_"   # 游客用户名前缀（禁止注册同名）
GUEST_COMPANY_PREFIX = "__游客_"     # 游客的伪公司名（不写入公司注册表）
GUEST_TTL_SECONDS = 25 * 3600         # 游客有效时长（略大于令牌 24h），超时自动清理

# 密码最小长度
MIN_PASSWORD_LEN = 6

# 邀请码级别
INVITE_LEVEL_MANAGER = 1   # 一级 → 管理员
INVITE_LEVEL_USER = 2      # 二级 → 用户


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _parse_expire(value) -> str:
    """将有效期（YYYY-MM-DD 或 ISO 时间）解析为 ISO 时间戳；空/非法 → 空（永久）"""
    value = (value or "").strip()
    if not value:
        return ""
    try:
        dt = datetime.fromisoformat(value)
    except Exception:
        try:
            dt = datetime.strptime(value, "%Y-%m-%d")
        except Exception:
            return ""
    if len(value) <= 10:  # 纯日期默认到当天 23:59:59
        dt = dt.replace(hour=23, minute=59, second=59)
    return dt.isoformat(timespec="seconds")


# ============================================================
# 读取 / 保存
# ============================================================

def _load_users() -> list:
    return read_json_enc(USERS_FILE, {}).get("users", [])


def _save_users(users: list) -> None:
    write_json_enc(USERS_FILE, {"users": users})


def _load_invites() -> list:
    return read_json_enc(INVITES_FILE, {}).get("codes", [])


def _save_invites(codes: list) -> None:
    write_json_enc(INVITES_FILE, {"codes": codes})


def _load_apikeys() -> dict:
    return read_json_enc(APIKEYS_FILE, {}).get("keys", {})


def _save_apikeys(keys: dict) -> None:
    write_json_enc(APIKEYS_FILE, {"keys": keys})


# ============================================================
# 公司数据库（映射库隔离凭证）
#
# 映射库（映射历史记录）按「公司名 + 公司数据库密码」隔离：
#   company_key = sha256(公司名 + "\x00" + 密码) 前 24 位
# 公司数据库密码由该公司管理员（manager）或最高级管理员（admin）创建/修改；
# 用户注册加入公司时必须填写并校验该公司密码（公司不存在则创建新公司）。
# 密码仅以加密形式存储于 companies.json，磁盘上无明文。
# ============================================================

def _load_companies() -> dict:
    return read_json_enc(COMPANIES_FILE, {}).get("companies", {})


def _save_companies(companies: dict) -> None:
    write_json_enc(COMPANIES_FILE, {"companies": companies})


def derive_company_key(company: str, db_password: str) -> str:
    """由公司名 + 公司数据库密码派生映射库隔离键（稳定、不可逆、不泄露密码）"""
    raw = f"{company or ''}\x00{db_password or ''}".encode("utf-8")
    return hashlib.sha256(raw).hexdigest()[:24]


def get_company_db_info(company: str):
    """返回公司数据库信息（不含明文密码）；公司不存在返回 None"""
    company = (company or "").strip()
    with _lock:
        rec = _load_companies().get(company)
        if not rec:
            return None
        return {
            "company": company,
            "created_at": rec.get("created_at", ""),
            "updated_at": rec.get("updated_at", ""),
            "created_by": rec.get("created_by", ""),
        }


def _ensure_company_db(company: str, db_password: str, creator_username: str) -> None:
    """确保公司数据库记录存在（不存在则创建）"""
    company = (company or "").strip()
    with _lock:
        companies = _load_companies()
        if company not in companies:
            companies[company] = {
                "db_pwd_enc": encrypt(db_password or ""),
                "created_at": _now(),
                "updated_at": _now(),
                "created_by": creator_username or "",
            }
            _save_companies(companies)


def update_company_db_password(actor_username: str, company: str, new_password: str) -> dict:
    """
    修改公司数据库密码。
    权限：admin 可修改任意公司；manager 仅可修改本公司。
    修改后：同步更新该公司所有用户的 company_key，并返回 old_key/new_key 供迁移映射库文件。
    """
    actor_username = (actor_username or "").strip()
    company = (company or "").strip()
    new_password = (new_password or "").strip()
    if len(new_password) < MIN_PASSWORD_LEN:
        return {"success": False, "message": f"公司数据库密码至少 {MIN_PASSWORD_LEN} 位"}
    with _lock:
        actor = _find_user_by_username(_load_users(), actor_username)
        if actor is None or actor.get("role") not in (ROLE_ADMIN, ROLE_MANAGER):
            return {"success": False, "message": "无权限"}
        if company != actor.get("company") and actor.get("role") != ROLE_ADMIN:
            return {"success": False, "message": "只能修改本公司的数据库密码"}

        companies = _load_companies()
        rec = companies.get(company)
        if not rec:
            return {"success": False, "message": "公司不存在，请先由成员注册创建"}

        old_key = derive_company_key(company, decrypt(rec.get("db_pwd_enc", "")))
        rec["db_pwd_enc"] = encrypt(new_password)
        rec["updated_at"] = _now()
        companies[company] = rec
        _save_companies(companies)

        # 重新计算该公司所有用户的 company_key
        new_key = derive_company_key(company, new_password)
        users = _load_users()
        changed = False
        for u in users:
            if u.get("company") == company:
                u["company_key"] = new_key
                changed = True
        if changed:
            _save_users(users)

        return {
            "success": True, "message": "公司数据库密码已修改",
            "company": company, "old_key": old_key, "new_key": new_key,
        }


def _cleanup_empty_companies() -> list:
    """
    自动清理「没有任何注册账号」的公司：
    - 删除 companies.json 中的公司记录（公司名 + 加密密码）
    - 删除该公司对应的映射库（图片库）文件 data/映射历史记录_{company_key}.json
    - 内置最高级管理员公司永不清理；其他公司仅当名下用户数为 0 时删除。
    返回被清理的公司名列表。
    """
    with _lock:
        users = _load_users()
        companies = _load_companies()
        if not companies:
            return []

        active_companies = {u.get("company", "") for u in users if u.get("company")}
        removed = []
        changed = False
        for company, rec in list(companies.items()):
            if company == SUPER_ADMIN_COMPANY:
                continue   # 内置公司永不清理
            if company in active_companies:
                continue   # 仍有注册账号，保留

            # 无注册账号 → 删除该公司映射库（图片库）文件
            company_key = derive_company_key(company, decrypt(rec.get("db_pwd_enc", "")))
            for path in (
                os.path.join(DATA_DIR, f"映射历史记录_{company_key}.json"),
                os.path.join(DATA_DIR, f"映射历史记录_{company}.json"),  # 旧版按公司名键的文件
            ):
                try:
                    if os.path.exists(path):
                        os.remove(path)
                except Exception:
                    pass

            companies.pop(company, None)
            changed = True
            removed.append(company)

        if changed:
            _save_companies(companies)
        return removed


# ============================================================
# 旧版数据迁移（backend/users → data/users，并转为加密文件）
# ============================================================

def _migrate_legacy() -> None:
    """
    将旧版 backend/users 下的账户数据迁移到 data/users。
    - 兼容旧版「明文 JSON + 字段级加密」文件：读取后以加密格式写回
    - 仅当所有现存旧文件均成功迁移后才删除旧目录，避免丢数据
    """
    if not os.path.isdir(LEGACY_USERS_DIR):
        return
    all_ok = True
    for fname in ("users.json", "invite_codes.json", "api_keys.json"):
        lp = os.path.join(LEGACY_USERS_DIR, fname)
        np = os.path.join(USERS_DIR, fname)
        if not os.path.exists(lp):
            continue
        if os.path.exists(np):
            continue  # 新文件已存在，以新文件为准
        data = read_json_enc(lp, None)   # 兼容明文 / 加密格式
        if data is None:
            all_ok = False
            continue
        write_json_enc(np, data)          # 写为加密文件
    if all_ok:
        try:
            shutil.rmtree(LEGACY_USERS_DIR)
        except Exception:
            pass


# ============================================================
# 用户对象转换（对外返回时脱敏）
# ============================================================

def _to_public(u: dict) -> dict:
    """返回给前端的用户信息（不暴露加密字段与密码）"""
    return {
        "id": u.get("id", ""),
        "username": u.get("username", ""),
        "email": decrypt(u.get("email_enc", "")),
        "company": u.get("company", ""),
        "role": u.get("role", ROLE_USER),
        "created_at": u.get("created_at", ""),
        "last_login_at": u.get("last_login_at", ""),
        "expires_at": u.get("expires_at"),
        "status": u.get("status", "active"),
        "is_guest": bool(u.get("is_guest")),
    }


def _find_user_by_username(users: list, username: str):
    uname = (username or "").strip()
    for u in users:
        if u.get("username") == uname:
            return u
    return None


def _find_user_by_id(users: list, uid: str):
    for u in users:
        if u.get("id") == uid:
            return u
    return None


def _is_expired(expires_at) -> bool:
    if not expires_at:
        return False  # 永久
    try:
        return datetime.fromisoformat(expires_at) < datetime.now()
    except Exception:
        return False


# ============================================================
# 初始化：内置最高级管理员
# ============================================================

def init_super_admin() -> None:
    """首次启动时创建内置最高级管理员（凭据来自环境变量或随机生成，先迁移旧版数据）"""
    with _lock:
        _migrate_legacy()
        users = _load_users()
        if _find_user_by_username(users, SUPER_ADMIN_USERNAME) is None:
            ph = hash_password(SUPER_ADMIN_PASSWORD)
            users.append({
                "id": uuid.uuid4().hex[:12],
                "username": SUPER_ADMIN_USERNAME,
                "password_hash_enc": encrypt(ph),          # 哈希串再加密存储
                "email_enc": encrypt(""),
                "company": SUPER_ADMIN_COMPANY,
                "company_key": derive_company_key(SUPER_ADMIN_COMPANY, SUPER_ADMIN_COMPANY_DB_PWD),
                "role": ROLE_ADMIN,
                "created_at": _now(),
                "last_login_at": "",
                "expires_at": None,                         # 永不过期
                "status": "active",
            })
            _save_users(users)
            _ensure_company_db(SUPER_ADMIN_COMPANY, SUPER_ADMIN_COMPANY_DB_PWD, SUPER_ADMIN_USERNAME)
            print("=" * 62)
            print("[初始化] 已创建内置最高级管理员，请立即登录并修改口令")
            print(f"  用户名:        {SUPER_ADMIN_USERNAME}")
            print(f"  密码:          {SUPER_ADMIN_PASSWORD}")
            print(f"  公司:          {SUPER_ADMIN_COMPANY}")
            print(f"  公司数据库密码: {SUPER_ADMIN_COMPANY_DB_PWD}")
            print("=" * 62)
        else:
            # 存量数据迁移：为已有用户的公司补全 company_key 与公司数据库记录
            _backfill_company_dbs(users)

    # 启动兜底：清理没有任何注册账号的公司（公司名 + 密码 + 对应映射库/图片库）
    _cleanup_empty_companies()
    # 服务重启后游客令牌全部失效：清理全部游客账号及其使用痕迹
    _cleanup_guests(force=True)


def _migrate_company_mapping_file(company: str, company_key: str) -> None:
    """将旧版「公司名键」映射库文件迁移到「公司名+密码派生键」文件，避免存量数据丢失"""
    if not company or not company_key:
        return
    old_path = os.path.join(DATA_DIR, f"映射历史记录_{company}.json")
    new_path = os.path.join(DATA_DIR, f"映射历史记录_{company_key}.json")
    try:
        if os.path.exists(old_path) and not os.path.exists(new_path):
            os.makedirs(os.path.dirname(new_path) or '.', exist_ok=True)
            os.replace(old_path, new_path)
    except Exception:
        pass


def _backfill_company_dbs(users: list) -> None:
    """
    存量数据迁移：对未设置 company_key 的用户 / 尚无数据库记录的公司，
    生成随机公司数据库密码并初始化，保证升级前的数据继续可用。
    （现有用户已写入 company_key，可继续访问；新用户加入需管理员告知密码）
    """
    companies = _load_companies()
    need_users_save = False
    need_companies_save = False
    for u in users:
        if u.get("is_guest"):
            continue   # 游客的伪公司不写入公司注册表
        company = (u.get("company") or "").strip()
        if not company:
            continue
        if company not in companies:
            companies[company] = {
                "db_pwd_enc": encrypt(secrets.token_urlsafe(12)),
                "created_at": _now(),
                "updated_at": _now(),
                "created_by": u.get("username", ""),
            }
            need_companies_save = True
        if not u.get("company_key"):
            u["company_key"] = derive_company_key(company, decrypt(companies[company].get("db_pwd_enc", "")))
            need_users_save = True
        # 迁移旧版「公司名键」映射库文件 → 派生键文件
        _migrate_company_mapping_file(company, u.get("company_key", ""))

    # 回填存量账户的 created_by（账号归属）：
    #   1) 用邀请码记录回填（used_by → creator）
    #   2) 仍缺失的，若其公司存在最高级管理员，回填为该最高级管理员
    creator_map = {}
    for c in _decode_codes(_load_invites()):
        if c.get("used") and c.get("used_by"):
            creator_map[c.get("used_by")] = c.get("creator")
    admin_of_company = {}
    for u in users:
        if u.get("role") == ROLE_ADMIN and u.get("company"):
            admin_of_company.setdefault(u.get("company"), u.get("username"))
    for u in users:
        if u.get("created_by"):
            continue
        uname = u.get("username")
        company = (u.get("company") or "").strip()
        if uname in creator_map:
            u["created_by"] = creator_map[uname]
        elif company in admin_of_company and uname != admin_of_company[company]:
            u["created_by"] = admin_of_company[company]
        if u.get("created_by"):
            need_users_save = True

    if need_companies_save:
        _save_companies(companies)
    if need_users_save:
        _save_users(users)


def public_user_by_username(username: str):
    with _lock:
        u = _find_user_by_username(_load_users(), username)
        return _to_public(u) if u else None


def user_by_username(username: str):
    """返回内部用户信息（含 company_key，供会话上下文使用；不暴露密码等敏感字段）"""
    with _lock:
        u = _find_user_by_username(_load_users(), (username or "").strip())
        if u is None:
            return None
        return {
            "id": u.get("id", ""),
            "username": u.get("username", ""),
            "company": u.get("company", ""),
            "company_key": u.get("company_key", ""),
            "role": u.get("role", ROLE_USER),
            "status": u.get("status", "active"),
            "expires_at": u.get("expires_at"),
            "is_guest": bool(u.get("is_guest")),
        }


# ============================================================
# 邀请码
# ============================================================

def _decode_codes(codes: list):
    """给每个邀请码附加明文 code，便于比对（内存中使用）"""
    out = []
    for c in codes:
        item = dict(c)
        item["_plain"] = decrypt(c.get("code_enc", ""))
        out.append(item)
    return out


def generate_invite(creator_username: str, level: int, expires_at: str = "") -> dict:
    """
    生成邀请码
    - admin 可生成 1 级（管理员）和 2 级（用户）；manager 仅可生成 2 级
    - expires_at 表示「用该邀请码注册的账户的有效期截止时间」（空 = 永久，账户到期后可删除）
    - 邀请码本身不设过期：未使用可随时使用，已使用/未使用均可随时删除
    """
    level = int(level)
    expires_at = _parse_expire(expires_at)
    with _lock:
        creator = _find_user_by_username(_load_users(), (creator_username or "").strip())
        if creator is None:
            return {"success": False, "message": "创建者账号不存在"}
        if creator.get("role") not in (ROLE_ADMIN, ROLE_MANAGER):
            return {"success": False, "message": "无权限生成邀请码"}
        if level == INVITE_LEVEL_MANAGER and creator.get("role") != ROLE_ADMIN:
            return {"success": False, "message": "只有最高级管理员可生成一级（管理员）邀请码"}
        if level not in (INVITE_LEVEL_MANAGER, INVITE_LEVEL_USER):
            return {"success": False, "message": "邀请码级别无效"}

        code = secrets.token_urlsafe(12)
        codes = _load_invites()
        codes.append({
            "id": uuid.uuid4().hex[:12],
            "code_enc": encrypt(code),
            "level": level,
            "creator": creator.get("username", ""),
            "used": False,
            "used_by": "",
            "created_at": _now(),
            "expires_at": expires_at,   # 注册账户的有效期截止时间（空 = 永久）
        })
        _save_invites(codes)
        return {
            "success": True,
            "message": "邀请码已生成",
            "code": code,
            "level": level,
            "expires_at": expires_at,
        }


def validate_invite(code_plain: str) -> dict:
    """校验邀请码（不修改状态）：返回 valid / reason / level。邀请码本身不过期，未使用即可用"""
    code_plain = (code_plain or "").strip()
    if not code_plain:
        return {"valid": False, "reason": "邀请码不能为空", "level": None}
    with _lock:
        for c in _decode_codes(_load_invites()):
            if c.get("_plain") == code_plain:
                if c.get("used"):
                    return {"valid": False, "reason": "该邀请码已被使用", "level": c.get("level")}
                return {"valid": True, "reason": "", "level": c.get("level")}
        return {"valid": False, "reason": "邀请码无效", "level": None}


def list_invites(actor_username: str) -> list:
    with _lock:
        actor = _find_user_by_username(_load_users(), (actor_username or "").strip())
        if actor is None:
            return []
        codes = _load_invites()
        # 自动清理：已使用（作废）的邀请码直接删除，不保留、不展示
        kept = [c for c in codes if not c.get("used")]
        if len(kept) != len(codes):
            _save_invites(kept)
            codes = kept
        codes = _decode_codes(codes)
        out = []
        for c in codes:
            if c.get("creator") != actor.get("username"):
                continue  # 仅显示自己创建的邀请码（与账号管理「仅见自己创建的」一致）
            out.append({
                "id": c.get("id", ""),
                "code": c.get("_plain", ""),
                "level": c.get("level"),
                "creator": c.get("creator", ""),
                "used": c.get("used", False),
                "used_by": c.get("used_by", ""),
                "created_at": c.get("created_at", ""),
                "expires_at": c.get("expires_at", ""),
                "valid_days": c.get("valid_days", 0),   # 旧数据兼容（仅显示用）
            })
        return out


def extend_invite(actor_username: str, code_plain: str, expires_at: str = "") -> dict:
    """设置邀请码对应的账户有效期截止时间（空 = 永久）"""
    expires_at = _parse_expire(expires_at)
    with _lock:
        actor = _find_user_by_username(_load_users(), (actor_username or "").strip())
        if actor is None or actor.get("role") not in (ROLE_ADMIN, ROLE_MANAGER):
            return {"success": False, "message": "无权限"}
        codes = _load_invites()
        for c in _decode_codes(codes):
            if c.get("_plain") == (code_plain or "").strip():
                if actor.get("role") != ROLE_ADMIN and c.get("creator") != actor.get("username"):
                    return {"success": False, "message": "无权操作该邀请码"}
                raw = c.get("_plain")
                for cc in codes:
                    if decrypt(cc.get("code_enc", "")) == raw:
                        cc["expires_at"] = expires_at
                        _save_invites(codes)
                        return {"success": True, "message": "已设置有效期", "expires_at": expires_at}
                break
        return {"success": False, "message": "邀请码不存在"}


def delete_invite(actor_username: str, code_plain: str) -> dict:
    """
    删除邀请码（作废/清理记录）。
    权限：admin 可删除任意；manager 仅可删除自己创建的。
    """
    with _lock:
        actor = _find_user_by_username(_load_users(), (actor_username or "").strip())
        if actor is None or actor.get("role") not in (ROLE_ADMIN, ROLE_MANAGER):
            return {"success": False, "message": "无权限"}
        code_plain = (code_plain or "").strip()
        if not code_plain:
            return {"success": False, "message": "邀请码不能为空"}
        codes = _load_invites()
        target = None
        for c in codes:
            if decrypt(c.get("code_enc", "")) == code_plain:
                target = c
                break
        if target is None:
            return {"success": False, "message": "邀请码不存在"}
        if actor.get("role") != ROLE_ADMIN and target.get("creator") != actor.get("username"):
            return {"success": False, "message": "无权删除该邀请码"}
        codes = [c for c in codes if c is not target]
        _save_invites(codes)
        return {"success": True, "message": "邀请码已删除"}


# ============================================================
# 注册 / 登录
# ============================================================

def register(username: str, password: str, email: str, invite_code: str,
             company: str, company_db_password: str) -> dict:
    """
    注册：用户名 + 密码 + 邮箱 + 邀请码 + 公司名称 + 公司数据库密码
    一级邀请码 → 管理员；二级邀请码 → 用户；邀请码绑定后作废。
    公司数据库密码：公司已存在则校验密码匹配才加入；公司不存在则创建新公司。
    """
    username = (username or "").strip()
    email = (email or "").strip()
    company = (company or "").strip()
    company_db_password = (company_db_password or "").strip()
    password = password or ""

    if username.startswith(GUEST_USERNAME_PREFIX):
        return {"success": False, "message": "该用户名不可用"}
    if not username or len(username) < 2:
        return {"success": False, "message": "用户名至少 2 个字符"}
    if len(password) < MIN_PASSWORD_LEN:
        return {"success": False, "message": f"密码至少 {MIN_PASSWORD_LEN} 位"}
    if "@" not in email or "." not in email:
        return {"success": False, "message": "邮箱格式不正确"}
    if not company:
        return {"success": False, "message": "请填写公司名称"}
    if not company_db_password:
        return {"success": False, "message": "请填写公司数据库密码"}
    if len(company_db_password) < MIN_PASSWORD_LEN:
        return {"success": False, "message": f"公司数据库密码至少 {MIN_PASSWORD_LEN} 位"}

    with _lock:
        users = _load_users()
        if _find_user_by_username(users, username) is not None:
            return {"success": False, "message": "用户名已存在"}

        # 校验邀请码
        v = validate_invite(invite_code)
        if not v["valid"]:
            return {"success": False, "message": v["reason"]}
        role = ROLE_MANAGER if v["level"] == INVITE_LEVEL_MANAGER else ROLE_USER

        # 公司数据库：已存在则校验密码，不存在则创建新公司数据库
        # 只有管理员（一级邀请码注册）可创建新公司；普通用户只能加入已有公司
        companies = _load_companies()
        if company in companies:
            if decrypt(companies[company].get("db_pwd_enc", "")) != company_db_password:
                return {"success": False, "message": "公司数据库密码错误，无法加入该公司"}
        else:
            if role != ROLE_MANAGER:
                return {"success": False,
                        "message": "该公司尚未创建数据库，只有管理员可创建新公司，请填写已有公司信息或联系公司管理员"}
            companies[company] = {
                "db_pwd_enc": encrypt(company_db_password),
                "created_at": _now(),
                "updated_at": _now(),
                "created_by": username,
            }
            _save_companies(companies)

        # 作废邀请码（使用即删除，不保留记录；创建者与有效期已记入新账号）
        codes = _load_invites()
        used_code = None
        inv_creator = ""
        inv_expires_at = ""
        inv_valid_days = 0
        for c in codes:
            if decrypt(c.get("code_enc", "")) == (invite_code or "").strip():
                used_code = c
                inv_creator = c.get("creator", "")
                inv_expires_at = c.get("expires_at") or ""
                inv_valid_days = int(c.get("valid_days", 0) or 0)   # 旧数据兼容
                break
        if used_code is None:
            return {"success": False, "message": "邀请码无效"}
        codes = [c for c in codes if c is not used_code]

        # 账户有效期 = 邀请码设置的截止日期（空 = 永久；旧数据按有效天数从当前时间起算）
        expires_at = None
        if inv_expires_at:
            expires_at = inv_expires_at
        elif inv_valid_days > 0:
            expires_at = (datetime.now() + timedelta(days=inv_valid_days)).isoformat(timespec="seconds")

        ph = hash_password(password)
        user = {
            "id": uuid.uuid4().hex[:12],
            "username": username,
            "password_hash_enc": encrypt(ph),
            "email_enc": encrypt(email),
            "company": company,
            "company_key": derive_company_key(company, company_db_password),
            "role": role,
            "created_by": inv_creator,   # 通过谁的邀请码注册（账号归属）
            "created_at": _now(),
            "last_login_at": _now(),
            "expires_at": expires_at,    # 账户到期后可删除
            "status": "active",
        }
        users.append(user)
        _save_users(users)
        _save_invites(codes)
        return {"success": True, "message": "注册成功", "user": _to_public(user)}


def login(username: str, password: str) -> dict:
    username = (username or "").strip()
    with _lock:
        users = _load_users()
        u = _find_user_by_username(users, username)
        if u is None:
            return {"success": False, "message": "用户名或密码错误"}
        if u.get("status") != "active":
            return {"success": False, "message": "账号已被禁用"}
        if _is_expired(u.get("expires_at")):
            return {
                "success": False,
                "code": "ACCOUNT_EXPIRED",
                "expires_at": u.get("expires_at"),
                "message": f"您的账户已于 {u.get('expires_at')} 过期，已被禁止登录。请尽快联系管理员延长账户有效期。",
            }

        ph = decrypt(u.get("password_hash_enc", ""))
        if not ph or not verify_password(password, ph):
            return {"success": False, "message": "用户名或密码错误"}

        u["last_login_at"] = _now()
        _save_users(users)
        return {"success": True, "message": "登录成功", "user": _to_public(u)}


# ============================================================
# 用户管理（admin / manager）
# ============================================================

def _created_by(username: str) -> set:
    """返回 username 创建的账户用户名集合（按用户记录的 created_by 字段，不依赖邀请码记录）"""
    out = set()
    for u in _load_users():
        if u.get("created_by") == (username or ""):
            out.add(u.get("username"))
    return out


def _can_manage(actor: dict, target_username: str) -> bool:
    """actor 是否可管理 target：仅限自己或自己创建的账户"""
    if not actor:
        return False
    return target_username == actor.get("username") or target_username in _created_by(actor.get("username"))


def list_users(actor_username: str) -> list:
    with _lock:
        actor = _find_user_by_username(_load_users(), (actor_username or "").strip())
        if actor is None or actor.get("role") not in (ROLE_ADMIN, ROLE_MANAGER):
            return []
        mine = _created_by(actor.get("username"))
        users = _load_users()
        # 仅返回：自己 + 自己创建的账户（不显示系统中所有账户；游客不展示）
        result = [u for u in users
                  if not u.get("is_guest")
                  and (u.get("username") == actor.get("username") or u.get("username") in mine)]
        return [_to_public(u) for u in result]


def extend_user(actor_username: str, user_id: str, expires_at: str = "") -> dict:
    """设置账号新的有效期截止时间（空 = 永久）"""
    expires_at = _parse_expire(expires_at)
    with _lock:
        actor = _find_user_by_username(_load_users(), (actor_username or "").strip())
        if actor is None or actor.get("role") not in (ROLE_ADMIN, ROLE_MANAGER):
            return {"success": False, "message": "无权限"}
        users = _load_users()
        target = _find_user_by_id(users, user_id)
        if target is None:
            return {"success": False, "message": "账号不存在"}
        if target.get("username") == SUPER_ADMIN_USERNAME:
            return {"success": False, "message": "不能修改最高级管理员"}
        if not _can_manage(actor, target.get("username")):
            return {"success": False, "message": "无权操作该账号"}

        target["expires_at"] = expires_at or None
        _save_users(users)
        return {"success": True, "message": "已设置有效期", "expires_at": target["expires_at"]}


def disable_user(actor_username: str, user_id: str) -> dict:
    """
    清除账号（设为禁用）。
    - admin 清除 manager 时，其下通过该 manager 二级邀请码注册的 user 同步清除
    """
    with _lock:
        actor = _find_user_by_username(_load_users(), (actor_username or "").strip())
        if actor is None or actor.get("role") not in (ROLE_ADMIN, ROLE_MANAGER):
            return {"success": False, "message": "无权限"}
        users = _load_users()
        target = _find_user_by_id(users, user_id)
        if target is None:
            return {"success": False, "message": "账号不存在"}
        if target.get("username") == SUPER_ADMIN_USERNAME:
            return {"success": False, "message": "不能清除最高级管理员"}
        if not _can_manage(actor, target.get("username")):
            return {"success": False, "message": "无权操作该账号"}

        removed_ids = {target.get("id")}
        removed_usernames = {target.get("username")}

        # 级联：admin 清除 manager → 其下用户同步清除
        if actor.get("role") == ROLE_ADMIN and target.get("role") == ROLE_MANAGER:
            # 该 manager 创建的账号（按用户记录 created_by，不依赖邀请码记录）
            for u in users:
                if u.get("created_by") == target.get("username") and u.get("id") not in removed_ids:
                    removed_ids.add(u.get("id"))
                    removed_usernames.add(u.get("username"))

        # 删除目标及其级联用户
        new_users = [u for u in users if u.get("id") not in removed_ids]
        _save_users(new_users)

        # 清理这些用户的 API Key
        keys = _load_apikeys()
        for uname in removed_usernames:
            keys.pop(uname, None)
        _save_apikeys(keys)

        # 清理该账号创建的邀请码（若为目标 manager，其所有邀请码一并作废删除）
        if target.get("role") == ROLE_MANAGER:
            codes = _load_invites()
            codes = [c for c in codes if c.get("creator") != target.get("username")]
            _save_invites(codes)

        # 自动清理：没有任何注册账号的公司（公司名 + 密码 + 对应映射库/图片库）
        cleaned = _cleanup_empty_companies()

        msg = f"已清除 {len(removed_ids)} 个账号"
        if cleaned:
            msg += "；并自动清理无账号公司：" + "、".join(cleaned)
        return {
            "success": True,
            "message": msg,
            "removed": len(removed_ids),
            "cleaned_companies": cleaned,
        }


# ============================================================
# 游客登录（临时账号，退出后自动清除全部使用痕迹）
# ============================================================

def _is_stale_guest(guest: dict, now: datetime) -> bool:
    """判断游客是否已失效（创建超过有效时长，此时令牌必然已过期）"""
    try:
        created = datetime.fromisoformat(guest.get("created_at", ""))
    except Exception:
        created = now
    return (now - created).total_seconds() > GUEST_TTL_SECONDS


def _delete_guest_data(guest: dict) -> None:
    """删除游客的所有使用痕迹：映射库（图片库）文件 + API Key"""
    company_key = guest.get("company_key", "")
    if company_key:
        path = os.path.join(DATA_DIR, f"映射历史记录_{company_key}.json")
        try:
            if os.path.exists(path):
                os.remove(path)
        except Exception:
            pass
    username = guest.get("username", "")
    if username:
        keys = _load_apikeys()
        if username in keys:
            keys.pop(username, None)
            _save_apikeys(keys)


def _cleanup_guests(force: bool = False) -> int:
    """清理游客账号及使用痕迹：force=True 全部清理（服务重启后令牌失效）；否则清理超时的"""
    with _lock:
        users = _load_users()
        now = datetime.now()
        kept = []
        removed = 0
        for u in users:
            if u.get("is_guest") and (force or _is_stale_guest(u, now)):
                _delete_guest_data(u)
                removed += 1
            else:
                kept.append(u)
        if removed:
            _save_users(kept)
        return removed


def create_guest() -> dict:
    """创建游客账号：独立伪公司 + 随机隔离键，角色 user（无管理界面），退出登录后自动清除"""
    with _lock:
        _cleanup_guests()   # 顺带清理已失效游客，避免累积
        users = _load_users()
        gid = secrets.token_hex(6)
        username = f"{GUEST_USERNAME_PREFIX}{gid}"
        company = f"{GUEST_COMPANY_PREFIX}{gid}"
        company_key = secrets.token_hex(12)   # 独立随机隔离键（映射库文件名依据）
        guest = {
            "id": uuid.uuid4().hex[:12],
            "username": username,
            "password_hash_enc": encrypt(hash_password(secrets.token_urlsafe(24))),  # 随机密码，无法密码登录
            "email_enc": encrypt(""),
            "company": company,
            "company_key": company_key,
            "role": ROLE_USER,
            "created_by": "",
            "created_at": _now(),
            "last_login_at": _now(),
            "expires_at": None,
            "status": "active",
            "is_guest": True,
        }
        users.append(guest)
        _save_users(users)
        return _to_public(guest)


def delete_guest(username: str) -> bool:
    """游客退出登录：删除账号记录 + 映射库/API Key 等全部使用痕迹"""
    with _lock:
        users = _load_users()
        guest = _find_user_by_username(users, username)
        if guest is None or not guest.get("is_guest"):
            return False
        _delete_guest_data(guest)
        users = [u for u in users if u.get("username") != username]
        _save_users(users)
        return True


# ============================================================
# 每账户 API Key（加密存储）
# ============================================================

def set_api_key(username: str, api_key: str) -> dict:
    username = (username or "").strip()
    with _lock:
        keys = _load_apikeys()
        rec = keys.get(username, {})
        rec["key_enc"] = encrypt(api_key)
        if not rec.get("created_at"):
            rec["created_at"] = _now()
        rec["updated_at"] = _now()
        # token 消耗按账户分账户独立累计（不同账户互不影响，与前端文案一致）
        rec.setdefault("total_tokens", 0)
        rec.setdefault("match_usage", 0)
        keys[username] = rec
        _save_apikeys(keys)
        return {"success": True, "message": "API Key 已保存"}


def get_api_key(username: str) -> str:
    username = (username or "").strip()
    with _lock:
        keys = _load_apikeys()
        rec = keys.get(username)
        return decrypt(rec.get("key_enc", "")) if rec else ""


def has_api_key(username: str) -> bool:
    return bool(get_api_key(username))


def masked_api_key(username: str) -> str:
    key = get_api_key(username)
    if not key:
        return ""
    if len(key) <= 8:
        return "*" * len(key)
    return key[:4] + "****" + key[-4:]


def key_fingerprint(api_key: str) -> str:
    import hashlib
    return hashlib.sha256((api_key or "").strip().encode("utf-8")).hexdigest()[:16]


def get_total_tokens(username: str) -> int:
    username = (username or "").strip()
    with _lock:
        rec = _load_apikeys().get(username)
        return int(rec.get("total_tokens", 0)) if rec else 0


def add_tokens(username: str, prompt_tokens: int, completion_tokens: int) -> None:
    username = (username or "").strip()
    with _lock:
        keys = _load_apikeys()
        rec = keys.get(username)
        if not rec:
            return
        rec["total_tokens"] = int(rec.get("total_tokens", 0)) + int(prompt_tokens or 0) + int(completion_tokens or 0)
        rec["updated_at"] = _now()
        keys[username] = rec
        _save_apikeys(keys)


def get_match_usage(username: str) -> int:
    username = (username or "").strip()
    with _lock:
        rec = _load_apikeys().get(username)
        return int(rec.get("match_usage", 0)) if rec else 0


def reset_match_usage(username: str) -> None:
    username = (username or "").strip()
    with _lock:
        keys = _load_apikeys()
        rec = keys.get(username)
        if rec:
            rec["match_usage"] = 0
            keys[username] = rec
            _save_apikeys(keys)


def add_match_usage(username: str, tokens: int) -> None:
    username = (username or "").strip()
    with _lock:
        keys = _load_apikeys()
        rec = keys.get(username)
        if rec:
            rec["match_usage"] = int(rec.get("match_usage", 0)) + int(tokens or 0)
            keys[username] = rec
            _save_apikeys(keys)
