"""
映射匹配库模块（映射历史记录）

记录用户的列映射关系（含 AI 匹配结果、手动调整、手动添加），
在后续匹配中优先应用。可视为一个「映射匹配数据库」。

存储格式（JSON）：
{
    "version": 1,
    "records": [
        {
            "id": "a1b2c3d4",
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
import re
import json
import uuid
from datetime import datetime
from typing import Optional

# 映射历史记录文件路径（统一放在项目主目录的 data/ 子目录下）
# 便于用户直接查看、备份或移植数据库文件；目录或文件被删除后会自动重新创建。
from config import DATA_DIR

HISTORY_FILE = os.path.join(DATA_DIR, "映射历史记录.json")

# 公司隔离：登录用户按公司使用各自独立的映射库（同一公司共享同一映射库）
try:
    import auth
except Exception:
    auth = None


def _safe_name(name: str) -> str:
    """将公司名规范化为安全的文件名片段"""
    s = re.sub(r'[^\w\u4e00-\u9fff-]', '_', str(name or "").strip())
    return s or "default"


def _company_key() -> str:
    """当前公司数据库隔离键（由「公司名 + 公司数据库密码」派生，未登录/无键时为空）"""
    if auth is not None:
        return auth.current_company_key() or ""
    return ""


def _records_path() -> str:
    """当前公司的映射库文件路径（未登录/无键时用全局文件）"""
    key = _company_key()
    if key:
        return os.path.join(DATA_DIR, f"映射历史记录_{key}.json")
    return HISTORY_FILE


def migrate_company_data(old_key: str, new_key: str) -> None:
    """公司数据库密码变更后，将旧隔离键下的映射库文件迁移到新隔离键（避免数据丢失）"""
    if not old_key or not new_key or old_key == new_key:
        return
    old_path = os.path.join(DATA_DIR, f"映射历史记录_{old_key}.json")
    new_path = os.path.join(DATA_DIR, f"映射历史记录_{new_key}.json")
    try:
        if os.path.exists(old_path) and not os.path.exists(new_path):
            os.makedirs(os.path.dirname(new_path) or '.', exist_ok=True)
            os.replace(old_path, new_path)
    except Exception:
        pass


def _new_id() -> str:
    """生成记录唯一 id"""
    return uuid.uuid4().hex[:8]


def _load_records() -> list:
    """从 JSON 文件加载所有记录，并保证每条记录都有 id"""
    path = _records_path()
    if not os.path.exists(path):
        return []
    try:
        with open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)
            records = data.get("records", [])
        # 为旧记录（无 id）补充 id
        for r in records:
            if not r.get("id"):
                r["id"] = _new_id()
        return records
    except (json.JSONDecodeError, IOError):
        return []


def _save_records(records: list):
    """保存所有记录到 JSON 文件"""
    path = _records_path()
    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump({
            "version": 1,
            "records": records,
        }, f, ensure_ascii=False, indent=2)


def _normalize_column_name(name: str) -> str:
    """标准化列名用于匹配查找"""
    if name is None:
        return ""
    return name.replace('\n', '').replace('\r', '').strip()


def _find_record(records: list, record_id: Optional[str] = None,
                 source_column: Optional[str] = None):
    """按 id 或源列名查找记录"""
    if record_id:
        for r in records:
            if r.get("id") == record_id:
                return r
    if source_column:
        src = _normalize_column_name(source_column)
        for r in records:
            if _normalize_column_name(r.get("source_column", "")) == src:
                return r
    return None


def add_mapping(source_column: str, target_column: str,
                source: str = "manual") -> Optional[dict]:
    """添加或更新一条映射记录（默认覆盖重复的源列名）"""
    action, record = add_mapping_ex(source_column, target_column, source,
                                    on_duplicate="overwrite")
    return record


def add_mapping_ex(source_column: str, target_column: str,
                   source: str = "manual",
                   on_duplicate: str = "overwrite") -> tuple:
    """
    添加或更新一条映射记录，支持重复数据处理方式。

    查重规则：仅以「原始列名 source_column」为准 ——
    原始列名相同（标准化后）即视为同一条映射，无论目标列是否相同。

    Args:
        source_column: 原始表格列名
        target_column: 目标表格列名（为空字符串时不记录/删除记录）
        source: 记录来源，取值：
            - "ai"      AI 匹配结果自动入库
            - "manual"  用户手动添加/修改
            - "import"  从文件导入
        on_duplicate: 当源列名已存在时的处理方式：
            - "overwrite"  覆盖更新已有记录的 target_column（默认）
            - "skip"       跳过，保留库中已有记录，不写入
            - "abort"      拒绝写入（返回 ("conflict", existing_record)）

    Returns:
        (action, record) 二元组：
            action  ∈ {"added", "updated", "skipped", "conflict"}
            record  为操作后的记录 dict；源列为空时返回 ("invalid", None)
    """
    source_clean = _normalize_column_name(source_column)
    if not source_clean:
        return ("invalid", None)

    now = datetime.now().isoformat(timespec='seconds')
    records = _load_records()

    # 查找是否已存在（仅以源列名为准）
    existing = None
    for record in records:
        if _normalize_column_name(record.get("source_column", "")) == source_clean:
            existing = record
            break

    if existing is not None:
        if on_duplicate == "skip":
            # 保留已有记录，不写入
            return ("skipped", existing)
        if on_duplicate == "abort":
            # 拒绝写入，交由调用方处理冲突
            return ("conflict", existing)
        # overwrite：更新已有记录的 target_column 与元数据
        existing["target_column"] = _normalize_column_name(target_column)
        existing["last_used"] = now
        existing["use_count"] = existing.get("use_count", 0) + 1
        if not existing.get("source"):
            existing["source"] = source
        if not existing.get("id"):
            existing["id"] = _new_id()
        _save_records(records)
        return ("updated", existing)

    # 新增记录
    record = {
        "id": _new_id(),
        "source_column": source_clean,
        "target_column": _normalize_column_name(target_column),
        "source": source,
        "last_used": now,
        "use_count": 1,
        "created_at": now,
    }
    records.append(record)
    _save_records(records)
    return ("added", record)


def check_duplicates(records: list) -> list:
    """
    检查一批待写入记录中，哪些源列名已存在于库中（视为重复）。

    查重规则：仅以原始列名 source_column 为准。

    Args:
        records: 待写入记录列表，元素为
                 {"source": ..., "target": ...} 或
                 {"source_column": ..., "target_column": ...}

    Returns:
        重复项列表，每项：
        {
            "source": 待写入的源列名,
            "target": 待写入的目标列名,
            "existing_id": 库中已有记录的 id,
            "existing_target": 库中已有记录的目标列名,
        }
    """
    library = {}
    for r in _load_records():
        library[_normalize_column_name(r.get("source_column", ""))] = r

    result = []
    for item in records:
        src = _normalize_column_name(
            item.get("source") or item.get("source_column") or "")
        tgt = _normalize_column_name(
            item.get("target") or item.get("target_column") or "")
        if not src:
            continue
        ex = library.get(src)
        if ex is not None:
            result.append({
                "source": src,
                "target": tgt,
                "existing_id": ex.get("id"),
                "existing_target": ex.get("target_column", ""),
            })
    return result


# ============================================================
# 映射匹配库 CRUD 接口（供前端数据管理页面调用）
# ============================================================

def list_mapping_records() -> list:
    """获取库中所有记录，按最近使用时间倒序"""
    records = _load_records()
    records.sort(key=lambda r: r.get("last_used", ""), reverse=True)
    return records


def add_mapping_record(source_column: str, target_column: str,
                       on_duplicate: str = "overwrite") -> dict:
    """新增/更新一条映射记录（前端「添加」按钮调用）

    on_duplicate: overwrite | skip | abort
    Returns:
        {"action": "added"|"updated"|"skipped"|"conflict", "record": {...}}
    """
    action, record = add_mapping_ex(source_column, target_column, "manual",
                                    on_duplicate=on_duplicate)
    if record is None:
        raise ValueError("源列名不能为空")
    return {"action": action, "record": record}


def update_mapping_record(record_id: str, source_column: Optional[str] = None,
                          target_column: Optional[str] = None,
                          on_duplicate: str = "overwrite") -> bool:
    """更新一条映射记录，返回是否更新成功

    若修改后的源列名与库中另一条记录重复（仅以源列名为准）：
        - overwrite: 删除另一条同源列名的记录，保证源列名唯一
        - skip/abort: 不执行更新，返回 False
    """
    records = _load_records()
    record = _find_record(records, record_id)
    if record is None:
        return False

    new_src = _normalize_column_name(source_column) if source_column is not None else None
    if new_src is not None:
        # 检查是否与其它记录冲突
        for other in records:
            if other.get("id") == record.get("id"):
                continue
            if _normalize_column_name(other.get("source_column", "")) == new_src:
                if on_duplicate in ("skip", "abort"):
                    return False
                # overwrite：删除被覆盖的同源记录
                records = [r for r in records
                           if r.get("id") != other.get("id")]
                break

    if source_column is not None:
        record["source_column"] = new_src
    if target_column is not None:
        record["target_column"] = _normalize_column_name(target_column)
    record["last_used"] = datetime.now().isoformat(timespec='seconds')
    if not record.get("id"):
        record["id"] = _new_id()
    _save_records(records)
    return True


def delete_mapping_record(record_id: Optional[str] = None,
                          source_column: Optional[str] = None) -> bool:
    """删除一条映射记录，返回是否删除成功"""
    records = _load_records()
    record = _find_record(records, record_id, source_column)
    if record is None:
        return False

    rid = record.get("id")
    src = record.get("source_column", "")
    records = [r for r in records
               if not (r.get("id") == rid or _normalize_column_name(r.get("source_column", "")) == _normalize_column_name(src))]
    _save_records(records)
    return True


def clear_mapping_records() -> int:
    """清空映射库，返回删除条数"""
    records = _load_records()
    count = len(records)
    _save_records([])
    return count


def _compute_saveable(mappings: list,
                      original_mappings: Optional[list] = None) -> list:
    """
    计算转换完成后应写入匹配库的映射列表（不含实际写入）。

    Rules:
    1. 用户勾选了 add_to_library=True 的映射 → 保存
    2. 未被修改的匹配结果（与原始匹配一致，含 AI 结果）→ 保存

    Returns:
        [{"source": src, "target": tgt, "tag": "ai"|"manual"}, ...]
    """
    if not mappings:
        return []

    # 构建原始映射 dict: source_column → target_column
    orig_dict = {}
    if original_mappings:
        for m in original_mappings:
            src = _normalize_column_name(m.get("source") or m.get("source_column", ""))
            tgt = _normalize_column_name(m.get("target") or m.get("target_column", ""))
            if src:
                orig_dict[src] = tgt

    saveable = []
    for m in mappings:
        src = _normalize_column_name(m.get("source") or "")
        tgt = _normalize_column_name(m.get("target") or "")
        if not src or not tgt:
            continue

        add_flag = bool(m.get("add_to_library", False))
        orig_tgt = orig_dict.get(src)

        # 规则 2：未被修改的匹配结果 → 保存（来源标记为 AI）
        if orig_tgt is not None and orig_tgt == tgt:
            saveable.append({"source": src, "target": tgt, "tag": "ai"})
            continue

        # 规则 1：用户勾选了加入库 → 保存（来源标记为手动）
        if add_flag:
            saveable.append({"source": src, "target": tgt, "tag": "manual"})

    return saveable


def preview_convert_duplicates(mappings: list,
                               original_mappings: Optional[list] = None) -> dict:
    """
    预检转换完成后待保存的映射，返回其中的重复项。

    查重规则：
    - 仅当库中已有「源列名相同但目标列名不同」的记录时，视为需要用户确认的重复项（弹窗）。
    - 「源列名与目标列名均相同」的完全重复项不视为需确认重复（写入无影响，直接处理，不弹窗）。

    Returns:
        {
            "saveable_count": 待保存总条数,
            "duplicates": [{source, target, existing_id, existing_target}, ...]
        }
    """
    saveable = _compute_saveable(mappings, original_mappings)

    # 构建库中记录: source_column(normalized) → record
    library = {}
    for r in _load_records():
        library[_normalize_column_name(r.get("source_column", ""))] = r

    dup_list = []
    for item in saveable:
        src = _normalize_column_name(item.get("source") or "")
        tgt = _normalize_column_name(item.get("target") or "")
        if not src:
            continue
        ex = library.get(src)
        if ex is None:
            continue
        existing_target = _normalize_column_name(ex.get("target_column", ""))
        # 仅源列名相同但目标列名不同 → 需要用户确认
        if existing_target != tgt:
            dup_list.append({
                "source": item.get("source") or src,
                "target": item.get("target") or tgt,
                "existing_id": ex.get("id"),
                "existing_target": ex.get("target_column", ""),
            })

    return {
        "saveable_count": len(saveable),
        "duplicates": dup_list,
    }


def save_convert_mappings(mappings: list,
                          original_mappings: Optional[list] = None,
                          on_duplicate: str = "overwrite") -> dict:
    """
    转换完成后保存映射到匹配库。

    Args:
        mappings: 前端最终映射列表
                  [{source, target, add_to_library(bool), ...}, ...]
        original_mappings: 匹配阶段的原始映射 [{source, target}, ...]
        on_duplicate: 重复处理方式 overwrite | skip | abort

    Returns:
        {"saved": int, "updated": int, "skipped": int, "conflict": int}
    """
    saveable = _compute_saveable(mappings, original_mappings)

    stats = {"saved": 0, "updated": 0, "skipped": 0, "conflict": 0}
    for item in saveable:
        action, _ = add_mapping_ex(
            item["source"], item["target"], source=item["tag"],
            on_duplicate=on_duplicate,
        )
        if action == "added":
            stats["saved"] += 1
        elif action == "updated":
            stats["updated"] += 1
        elif action == "skipped":
            stats["skipped"] += 1
        else:
            stats["conflict"] += 1

    return stats


def import_mapping_records(records: list, mode: str = "merge",
                           on_duplicate: str = "overwrite") -> int:
    """
    批量导入映射记录。

    Args:
        records: 记录列表，每个元素为
                 {"source_column": ..., "target_column": ..., "source": ...}
                 （兼容 "source"/"target" 键名）
        mode:
            - "merge"   合并模式：按源列名更新或新增，保留库中已有记录
            - "replace" 覆盖模式：先清空库再导入
        on_duplicate: 重复处理方式（merge 模式生效）
            - overwrite  覆盖已有
            - skip       跳过已有
            - abort      拒绝写入

    Returns:
        成功写入的条数（skip 跳过的计入成功条数但不算新增）
    """
    if mode == "replace":
        _save_records([])

    count = 0
    for r in records:
        src = r.get("source_column") or r.get("source") or ""
        tgt = r.get("target_column") or r.get("target") or ""
        if not src or not tgt:
            continue
        src_name = _normalize_column_name(src)
        tgt_name = _normalize_column_name(tgt)
        if not src_name or not tgt_name:
            continue
        rec_source = r.get("source", "import")
        if rec_source not in ("ai", "manual", "import"):
            rec_source = "import"
        action, _ = add_mapping_ex(src_name, tgt_name, source=rec_source,
                                   on_duplicate=on_duplicate)
        if action in ("added", "updated", "skipped"):
            count += 1

    return count


def batch_delete_mapping_records(ids: list) -> int:
    """批量删除指定 id 的映射记录，返回删除条数"""
    if not ids:
        return 0
    id_set = set(ids)
    records = _load_records()
    new_records = [r for r in records if r.get("id") not in id_set]
    deleted = len(records) - len(new_records)
    if deleted:
        _save_records(new_records)
    return deleted


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
