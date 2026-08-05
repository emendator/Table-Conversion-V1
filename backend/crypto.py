"""
加密 / 安全工具模块

- 密码哈希：PBKDF2-HMAC-SHA256（加盐，不可逆，200000 次迭代）
- 对称加密：本地密钥文件(.ai_secret) + PBKDF2 派生密钥 + XOR 流加密，
  用于邀请码、API Key、邮箱等敏感字段（复用 ai_config 的密钥体系）。
- 原子 JSON 读写（tmp + os.replace），保证并发写不产生半截文件。
"""

import os
import json
import base64
import hashlib
import secrets

from config import DATA_DIR

# 加密密钥文件（与 ai_config 共用同一密钥体系，保证同一套加密/解密可用）
SECRET_FILE = os.path.join(DATA_DIR, ".ai_secret")

# ============================================================
# 对称加密（用于敏感字段：邀请码 / API Key / 邮箱 / 密码哈希串）
# ============================================================

def _load_or_create_secret() -> bytes:
    """加载本地随机密钥文件，不存在则生成"""
    if os.path.exists(SECRET_FILE):
        try:
            with open(SECRET_FILE, "rb") as f:
                s = f.read()
            if len(s) >= 16:
                return s
        except Exception:
            pass
    s = secrets.token_bytes(32)
    try:
        os.makedirs(os.path.dirname(SECRET_FILE) or '.', exist_ok=True)
        with open(SECRET_FILE, "wb") as f:
            f.write(s)
    except Exception:
        pass
    return s


def _derive_key(secret: bytes, salt: bytes) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", secret, salt, 120_000, dklen=32)


def _xor_crypt(data: bytes, key: bytes) -> bytes:
    return bytes(b ^ key[i % len(key)] for i, b in enumerate(data))


# 启动时确保解密密钥文件存在
_load_or_create_secret()


def encrypt(plain) -> str:
    """加密：salt + XOR 密文 → base64url（salt 内嵌，解密自包含）"""
    if plain is None:
        return ""
    secret = _load_or_create_secret()
    salt = secrets.token_bytes(16)
    key = _derive_key(secret, salt)
    ct = _xor_crypt(str(plain).encode("utf-8"), key)
    return base64.urlsafe_b64encode(salt + ct).decode()


def decrypt(token: str) -> str:
    if not token:
        return ""
    try:
        secret = _load_or_create_secret()
        raw = base64.urlsafe_b64decode(token.encode())
        salt, ct = raw[:16], raw[16:]
        key = _derive_key(secret, salt)
        return _xor_crypt(ct, key).decode("utf-8")
    except Exception:
        return ""


# ============================================================
# 密码哈希（PBKDF2-HMAC-SHA256，加盐）
# ============================================================

_PBKDF2_ITER = 200_000


def hash_password(password: str) -> str:
    """生成密码哈希：pbkdf2$iter$salt_b64$hash_b64"""
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, _PBKDF2_ITER, dklen=32)
    return "pbkdf2${}${}${}".format(
        _PBKDF2_ITER,
        base64.b64encode(salt).decode(),
        base64.b64encode(dk).decode(),
    )


def verify_password(password: str, stored: str) -> bool:
    """校验密码，使用恒定时间比较防时序攻击"""
    try:
        algo, iter_s, salt_b64, hash_b64 = stored.split("$")
        if algo != "pbkdf2":
            return False
        salt = base64.b64decode(salt_b64)
        dk = base64.b64decode(hash_b64)
        new_dk = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), salt, int(iter_s), dklen=len(dk)
        )
        return secrets.compare_digest(new_dk, dk)
    except Exception:
        return False


# ============================================================
# JSON 读写（原子写入）
# ============================================================

def read_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def write_json(path, data) -> None:
    tmp = path + ".tmp"
    try:
        os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
    except Exception:
        pass


# ============================================================
# 文件级加密（用于用户数据文件整体加密）
#
# 说明：
#   将整个 JSON 序列化后整体加密写入文件，磁盘上的数据文件为密文，
#   避免用户名 / 公司名 / 结构等元信息以明文落盘。
#   与字段级加密（密码哈希、API Key、邮箱、邀请码再加密）形成双保险。
#
#   兼容旧版明文 JSON：旧数据文件（backend/users/*.json）为「明文 JSON +
#   字段级加密」格式，read_json_enc 会自动识别并读取，迁移后再以加密格式写回。
# ============================================================

def write_json_enc(path, data) -> None:
    """将数据序列化后整体加密并原子写入（磁盘上为密文）"""
    plain = json.dumps(data, ensure_ascii=False, indent=2)
    content = encrypt(plain)
    tmp = path + ".tmp"
    try:
        os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(content)
        os.replace(tmp, path)
    except Exception:
        pass


def read_json_enc(path, default):
    """
    读取加密 JSON 文件；兼容旧版明文 JSON（用于数据迁移）。
    返回解析后的 dict / list；文件缺失、损坏或密钥不匹配时返回 default。
    """
    try:
        with open(path, "r", encoding="utf-8") as f:
            content = f.read()
    except Exception:
        return default

    # 优先按加密格式解析（decrypt 失败返回 ""，json.loads 抛异常即回退）
    plain = decrypt(content)
    if plain:
        try:
            return json.loads(plain)
        except Exception:
            pass
    # 兼容旧版明文 JSON（字段级加密）—— 迁移场景
    try:
        return json.loads(content)
    except Exception:
        return default
