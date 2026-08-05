"""
DeepSeek API 配置管理模块（按账户隔离）

- 每个账户的 API Key 独立加密存储于 data/users/api_keys.json（见 user_system）
- token 消耗统计按账户记录
- 当前账户由请求上下文（auth.current_username）决定；
  非请求上下文（如 CLI）回退到内置最高级管理员账户
"""

import hashlib

import user_system
import auth


def _username() -> str:
    """当前账户名：优先请求上下文，否则回退到内置最高级管理员"""
    return auth.current_username() or user_system.SUPER_ADMIN_USERNAME


def key_fingerprint(api_key: str) -> str:
    """API Key 指纹：仅用于标识与统计，不泄露明文"""
    return hashlib.sha256((api_key or "").strip().encode("utf-8")).hexdigest()[:16]


def get_api_key() -> str:
    return user_system.get_api_key(_username())


def has_api_key() -> bool:
    return user_system.has_api_key(_username())


def masked_api_key() -> str:
    return user_system.masked_api_key(_username())


def save_api_key(api_key: str) -> None:
    user_system.set_api_key(_username(), api_key)


def get_total_tokens() -> int:
    return user_system.get_total_tokens(_username())


def add_tokens(prompt_tokens, completion_tokens) -> None:
    user_system.add_tokens(_username(), prompt_tokens, completion_tokens)


def get_match_usage() -> int:
    return user_system.get_match_usage(_username())


def reset_match_usage() -> None:
    user_system.reset_match_usage(_username())


def add_match_usage(total_tokens) -> None:
    user_system.add_match_usage(_username(), total_tokens)
