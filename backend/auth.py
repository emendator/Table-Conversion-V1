"""
认证与权限模块

- 登录令牌（token）会话：登录后签发，登出失效，有效期 24 小时
- 使用 contextvars 在请求级保存当前用户 / 当前公司，
  供 ai_config（按账户 API Key）、mapping_history（按公司映射库）无参获取
- 提供 FastAPI 依赖：require_login / require_role
"""

import secrets
import time
import threading
import contextvars
from datetime import datetime, timedelta

from fastapi import Depends, HTTPException, Request

import user_system

# 登录令牌：token -> {username, expires_at}
_TOKENS = {}
_tokens_lock = threading.RLock()

TOKEN_TTL_SECONDS = 24 * 3600  # 令牌有效期 24 小时

# 请求级上下文：当前登录用户 / 当前公司 / 当前公司数据库隔离键
_current_user: contextvars.ContextVar = contextvars.ContextVar("current_user", default=None)
_current_company: contextvars.ContextVar = contextvars.ContextVar("current_company", default="")
_current_company_key: contextvars.ContextVar = contextvars.ContextVar("current_company_key", default="")


# ============================================================
# 令牌会话
# ============================================================

def _cleanup_expired() -> None:
    now = time.time()
    expired = [t for t, rec in _TOKENS.items() if rec["expires_at"] < now]
    for t in expired:
        _TOKENS.pop(t, None)


def create_token(username: str) -> str:
    """登录成功后签发令牌"""
    token = secrets.token_urlsafe(32)
    with _tokens_lock:
        _cleanup_expired()
        _TOKENS[token] = {"username": username, "expires_at": time.time() + TOKEN_TTL_SECONDS}
    return token


def revoke_token(token: str) -> None:
    with _tokens_lock:
        _TOKENS.pop(token, None)


def get_user_by_token(token: str):
    """根据令牌返回用户信息（含角色、公司），无效/过期返回 None"""
    if not token:
        return None
    with _tokens_lock:
        _cleanup_expired()
        rec = _TOKENS.get(token)
        if not rec:
            return None
        user = user_system.user_by_username(rec["username"])
        if not user or user.get("status") != "active":
            return None
        # 过期账号拒绝
        expires = user.get("expires_at")
        if expires:
            try:
                if datetime.fromisoformat(expires) < datetime.now():
                    _TOKENS.pop(token, None)
                    return None
            except Exception:
                pass
        return user


# ============================================================
# 请求级上下文访问（供 ai_config / mapping_history 使用）
# ============================================================

def set_context(user: dict) -> None:
    """在请求上下文中记录当前用户、公司与公司数据库隔离键"""
    _current_user.set(user)
    _current_company.set((user or {}).get("company", ""))
    _current_company_key.set((user or {}).get("company_key", ""))


def current_username() -> str:
    u = _current_user.get()
    return (u or {}).get("username", "") if u else ""


def current_company() -> str:
    return _current_company.get()


def current_company_key() -> str:
    """当前公司数据库隔离键（映射库文件名依据；未登录为空）"""
    return _current_company_key.get()


# ============================================================
# FastAPI 依赖
# ============================================================

def _extract_token(request: Request) -> str:
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return auth[len("Bearer "):].strip()
    return ""


async def require_login(request: Request):
    """要求已登录，返回当前用户 dict。

    注意：必须为 async 依赖。FastAPI 的同步(def)依赖在线程池中执行，
    其中设置的 contextvars 无法传播到 async 路由（见 _ctx_test 验证），
    会导致 ai_config/mapping_history 拿不到当前用户而回退到 admin。
    """
    token = _extract_token(request)
    user = get_user_by_token(token)
    if user is None:
        raise HTTPException(status_code=401, detail="未登录或登录已过期")
    set_context(user)
    # 不把 company_key（映射库隔离键）暴露给前端
    return {k: v for k, v in user.items() if k != "company_key"}


def require_role(*roles):
    """要求指定角色（admin / manager / user）。

    注意：返回的 dependency 必须是 async 依赖，理由同 require_login
    （async 依赖链在同一个请求上下文中运行，contextvars 才能正确传播）。
    """
    async def dependency(request: Request, user: dict = Depends(require_login)):
        if user.get("role") not in roles:
            raise HTTPException(status_code=403, detail="无权限执行该操作")
        return user
    return dependency


# 便捷依赖
require_admin = require_role(user_system.ROLE_ADMIN)
require_manager = require_role(user_system.ROLE_ADMIN, user_system.ROLE_MANAGER)
