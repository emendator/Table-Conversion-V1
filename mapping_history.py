"""
映射历史记录模块

记录用户手动修改/添加的列映射关系，并在后续匹配中优先应用。
每次匹配时，会根据用户历史记录自动调整匹配结果，无需每次都手动修改。

存储格式（JSON）：
{
    "version": 1,
    "records": [
        {
            "source_column": "产品",
            "target_column": "型号",
            "last_used": "2026-07-10T12:00:00",
            "use_count": 5,
            "created_at": "2026-07-01T10:00:00"
        }
    ]
}
"""

import os
import json
from datetime import datetime
from typing import Optional

# 映射历史记录文件路径（存放在项目根目录）
HISTORY_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "映射历史记录.json")


def _load_records() -> list:
    """从 JSON 文件加载所有历史记录"""
    if not os.path.exists(HISTORY_FILE):
        return []
    try:
        with open(HISTORY_FILE, 'r', encoding='utf-8') as f:
            data = json.load(f)
            return data.get("records", [])
    except (json.JSONDecodeError, IOError):
        return []


def _save_records(records: list):
    """保存所有历史记录到 JSON 文件"""
    os.makedirs(os.path.dirname(HISTORY_FILE) or '.', exist_ok=True)
    with open(HISTORY_FILE, 'w', encoding='utf-8') as f:
        json.dump({
            "version": 1,
            "records": records,
        }, f, ensure_ascii=False, indent=2)


def _normalize_column_name(name: str) -> str:
    """标准化列名用于匹配查找"""
    if name is None:
        return ""
    return name.replace('\n', '').replace('\r', '').strip()


def add_mapping(source_column: str, target_column: str):
    """
    添加或更新一条映射记录。

    如果 source_column 已存在于历史记录中，更新其 target_column 和元数据；
    否则新增一条记录。

    Args:
        source_column: 原始表格列名
        target_column: 目标表格列名（为空字符串时不记录/删除记录）
    """
    source_clean = _normalize_column_name(source_column)
    if not source_clean:
        return

    now = datetime.now().isoformat(timespec='seconds')
    records = _load_records()

    # 查找是否已存在
    for record in records:
        if _normalize_column_name(record["source_column"]) == source_clean:
            # 更新记录
            record["target_column"] = target_column
            record["last_used"] = now
            record["use_count"] = record.get("use_count", 0) + 1
            _save_records(records)
            return

    # 新增记录
    records.append({
        "source_column": source_clean,
        "target_column": target_column,
        "last_used": now,
        "use_count": 1,
        "created_at": now,
    })
    _save_records(records)


def batch_add_mappings(mappings: list, source_headers: list = None,
                       original_mappings: list = None):
    """
    批量添加/更新映射记录，智能识别用户手动修改的映射。

    逻辑：
    1. 如果原始自动映射中存在该源列且目标列被用户改变 → 视为「手动修改」，记录
    2. 如果是用户手动添加的全新映射（original_mappings 中不存在该源列）→ 记录
    3. target 为空的映射不记录（用户取消了映射）

    Args:
        mappings: 用户最终确认的映射列表
                  [{source: "...", target: "...", confidence: "...", reason: "..."}, ...]
        source_headers: 所有源表列名列表（用于识别哪些列被删除了映射）
        original_mappings: 匹配阶段生成的原始映射列表（用于对比哪些被用户修改了）
    """
    if not mappings:
        return

    # 构建原始映射 dict: source_column → target_column
    orig_dict = {}
    if original_mappings:
        for m in original_mappings:
            src = _normalize_column_name(m.get("source") or m.get("source_column", ""))
            tgt = _normalize_column_name(m.get("target") or m.get("target_column", ""))
            if src:
                orig_dict[src] = tgt

    for m in mappings:
        src = _normalize_column_name(m.get("source") or m.get("source_column", ""))
        tgt = _normalize_column_name(m.get("target") or m.get("target_column", ""))
        if not src:
            continue
        if not tgt:
            continue

        orig_tgt = orig_dict.get(src)
        if orig_tgt is None:
            # 原始匹配中没有这个源列 → 用户手动添加的映射
            add_mapping(src, tgt)
        elif orig_tgt != tgt:
            # 用户手动修改了目标列
            add_mapping(src, tgt)
        # else: 映射未改变，不记录（降低重复噪音）


def get_history_mappings() -> list:
    """
    获取所有历史映射记录，按使用次数降序排列。

    Returns:
        [(source_column, target_column), ...]
    """
    records = _load_records()
    # 按 use_count 降序排列，使用越频繁的排越前
    records.sort(key=lambda r: r.get("use_count", 0), reverse=True)
    result = []
    for r in records:
        src = r.get("source_column", "")
        tgt = r.get("target_column", "")
        if src and tgt:
            result.append((src, tgt))
    return result


def get_history_mapping_for_source(source_column: str) -> Optional[str]:
    """
    查询某源列名的历史映射目标列名。

    Args:
        source_column: 源列名

    Returns:
        目标列名，如果找不到则返回 None
    """
    src_clean = _normalize_column_name(source_column)
    if not src_clean:
        return None
    records = _load_records()
    for r in records:
        if _normalize_column_name(r.get("source_column", "")) == src_clean:
            return r.get("target_column")
    return None


def get_history_mappings_dict() -> dict:
    """
    获取所有历史映射记录的字典形式。

    Returns:
        {source_column: target_column, ...}
    """
    result = {}
    records = _load_records()
    for r in records:
        src = _normalize_column_name(r.get("source_column", ""))
        tgt = r.get("target_column", "")
        if src and tgt:
            result[src] = tgt
    return result


def clear_history():
    """清空所有历史记录"""
    _save_records([])
