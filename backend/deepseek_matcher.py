"""
DeepSeek AI 智能列名匹配模块
使用 DeepSeek 大模型将源表格列名智能匹配到目标表格列名
"""

import json
import re
import requests
from config import (
    DEEPSEEK_API_KEY,
    DEEPSEEK_API_URL,
    DEEPSEEK_MODEL,
    HEADER_MATCHING_PROMPT,
    SPECIAL_MAPPINGS,
    NOT_MAPPING_TO_NEW_PRICE_KEYWORDS,
)
from mapping_history import get_history_mappings_dict


def call_deepseek_api(prompt: str, max_tokens: int = 8192) -> str:
    """调用 DeepSeek API 并返回回复内容"""
    headers = {
        "Authorization": f"Bearer {DEEPSEEK_API_KEY}",
        "Content-Type": "application/json",
    }
    
    payload = {
        "model": DEEPSEEK_MODEL,
        "messages": [
            {"role": "user", "content": f"你是一个专业的Excel表格列名匹配专家。请严格按照JSON格式返回结果。\n\n{prompt}"},
        ],
        "max_tokens": max_tokens,
        "temperature": 0.1,
    }
    
    # Pro 模型支持 thinking 参数
    if 'pro' in DEEPSEEK_MODEL.lower():
        payload["thinking"] = {"type": "disabled"}
    
    try:
        response = requests.post(DEEPSEEK_API_URL, headers=headers, json=payload, timeout=120)
        response.raise_for_status()
        result = response.json()
        content = result["choices"][0]["message"]["content"]
        return content
    except requests.exceptions.Timeout:
        raise RuntimeError("DeepSeek API 请求超时，请检查网络连接")
    except requests.exceptions.RequestException as e:
        raise RuntimeError(f"DeepSeek API 请求失败: {e}")
    except (KeyError, IndexError) as e:
        raise RuntimeError(f"DeepSeek API 返回格式异常: {e}")


def extract_json_from_response(response: str) -> dict:
    """从API响应中提取JSON（处理截断、markdown代码块等边缘情况）"""
    # 尝试直接解析
    try:
        return json.loads(response)
    except json.JSONDecodeError:
        pass
    
    # 尝试从 Markdown 代码块中提取
    json_match = re.search(r'```(?:json)?\s*\n?(.*?)\n?```', response, re.DOTALL)
    if json_match:
        try:
            return json.loads(json_match.group(1))
        except json.JSONDecodeError:
            pass
    
    # 尝试找最后一个完整的JSON对象
    # 从第一个 { 开始，逆向找最后一个可以解析的有效JSON
    start = response.find('{')
    if start != -1:
        # 从末尾向前尝试，找到第一个能成功解析的截断点
        for end in range(len(response), start, -1):
            candidate = response[start:end]
            # 补全可能缺失的括号
            open_braces = candidate.count('{') - candidate.count('}')
            open_brackets = candidate.count('[') - candidate.count(']')
            candidate_padded = candidate + ']' * open_brackets + '}' * open_braces
            try:
                return json.loads(candidate_padded)
            except json.JSONDecodeError:
                continue
    
    raise RuntimeError(f"无法从API响应中提取JSON:\n{response[:500]}")


def normalize_header(header: str) -> str:
    """标准化表头字符串"""
    import pandas as pd
    if pd.isna(header):
        return ""
    return str(header).replace('\n', '').replace('\r', '').strip()


def _sample_column_data(df, headers, max_samples=3):
    """为每列抽取样本数据，格式化为可读字符串"""
    import random
    lines = []
    for h in headers:
        if h not in df.columns:
            lines.append(f'  "{h}": (无数据)')
            continue
        col_data = df[h].dropna()
        if len(col_data) == 0:
            lines.append(f'  "{h}": (空列)')
            continue
        # 随机抽取最多 max_samples 个值
        samples = col_data.sample(n=min(max_samples, len(col_data)), random_state=42).tolist()
        # 截断过长的值
        display = [str(v)[:60] for v in samples]
        lines.append(f'  "{h}": {display}')
    return '\n'.join(lines)


def build_matching_prompt(source_headers: list, target_headers: list,
                          source_df=None, reference_df=None, reference_headers=None,
                          formula_columns=None) -> str:
    """构建列名匹配的提示词（含表头+数据采样）"""
    # 公式列：从参考模板的 formula_info 中动态获取（以 = 开头的列对应的表头名）
    if formula_columns is None:
        formula_columns = []
    
    # 过滤掉目标表中的公式列
    skip_set = set(formula_columns)
    filtered_target = [
        h for h in target_headers 
        if normalize_header(h) not in skip_set
    ]
    
    # 构建源表每列数据样本
    if source_df is not None and len(source_df) > 0:
        source_samples = _sample_column_data(source_df, source_headers)
    else:
        source_samples = '\n'.join(f'  "{h}": (无样本数据)' for h in source_headers)
    
    # 构建目标表每列数据样本（从参考模板的数据行读取）
    if reference_df is not None and reference_headers is not None and len(reference_df) > 0:
        target_samples = _sample_column_data(reference_df, filtered_target)
    else:
        target_samples = '\n'.join(f'  "{h}": (无样本数据)' for h in filtered_target)
    
    return HEADER_MATCHING_PROMPT.format(
        skip_columns=', '.join(formula_columns) if formula_columns else '无',
        target_samples=target_samples,
        source_samples=source_samples,
    )


def apply_special_mappings(source_headers: list, target_headers: list) -> list:
    """应用特殊映射规则（硬编码规则）"""
    mappings = []
    
    for src_col in source_headers:
        src_clean = str(src_col).replace('\n', '').strip()
        
        for keyword, target in SPECIAL_MAPPINGS.items():
            if keyword in src_clean:
                # 检查是否在排除列表中
                excluded = False
                for exclude_kw in NOT_MAPPING_TO_NEW_PRICE_KEYWORDS:
                    if exclude_kw in src_clean:
                        excluded = True
                        break
                
                if not excluded:
                    # 查找匹配的目标列
                    for tgt_col in target_headers:
                        tgt_clean = str(tgt_col).replace('\n', '').strip()
                        if target in tgt_clean:
                            mappings.append({
                                "source_column": src_col,
                                "target_column": tgt_col,
                                "confidence": "high",
                                "reason": f"特殊规则: 包含'{keyword}'的列映射到'{target}'"
                            })
                            break
    
    return mappings


# ============================================================
# 本地智能匹配（不使用 AI 时的优化算法）
# ============================================================

def _norm(s: str) -> str:
    """标准化列名：去换行、去空格、转小写"""
    if s is None:
        return ""
    return str(s).replace('\n', '').replace('\r', '').strip().lower()


def _char_similarity(a: str, b: str) -> float:
    """计算两个字符串的字符级相似度 (0~1)，基于公共字符占比"""
    if not a or not b:
        return 0.0
    set_a, set_b = set(a), set(b)
    if not set_a or not set_b:
        return 0.0
    intersection = set_a & set_b
    return 2.0 * len(intersection) / (len(set_a) + len(set_b))


def _column_data_type(df, col_name, max_samples=20) -> str:
    """推断列的数据类型：'number' / 'text' / 'mixed' / 'empty'
    用于辅助本地匹配时判断两列是否同类。"""
    import pandas as pd
    if df is None or col_name not in df.columns:
        return 'empty'
    col = df[col_name].dropna()
    if len(col) == 0:
        return 'empty'
    
    # 取最多 max_samples 个样本判断类型
    samples = col.head(max_samples)
    num_count = 0
    text_count = 0
    for v in samples:
        try:
            float(str(v).replace(',', '').replace('¥', '').replace('￥', '').replace('$', '').strip())
            num_count += 1
        except (ValueError, TypeError):
            text_count += 1
    
    total = num_count + text_count
    if total == 0:
        return 'empty'
    num_ratio = num_count / total
    if num_ratio >= 0.8:
        return 'number'
    elif text_count / total >= 0.8:
        return 'text'
    else:
        return 'mixed'


def _infer_data_type_from_header(header_norm: str) -> str:
    """根据列名推断期望的数据类型，用于辅助匹配"""
    price_keywords = ['价', '价格', '金额', '金额', '成本', '费用', '毛利率', '毛利', 
                      '售价', '进价', '批发', '零售', '代发', '商谈', '报价']
    num_keywords = ['序号', '编号', '数量', '序号', '排名', '排序', '进度', '比例', '%']
    img_keywords = ['图片', '照片', '图像', '图', 'pic', 'img', 'image']
    
    if any(k in header_norm for k in img_keywords):
        return 'image'
    if any(k in header_norm for k in price_keywords):
        return 'price'
    if any(k in header_norm for k in num_keywords):
        return 'number'
    return 'text'


# 领域关键词映射表：{领域: [(源关键词, 权重), ...]}
# 用于在本地匹配中将源列按语义分组，再匹配到最合适的目标列
_DOMAIN_KEYWORDS = {
    "id":         ["序号", "编号", "序列", "id", "no", "number", "流水号", "行号", "序号"],
    "image":      ["图片", "照片", "图像", "图", "pic", "img", "image", "photo"],
    "model":      ["型号", "产品", "品名", "名称", "商品", "货号", "规格", "model", 
                   "产品名称", "商品名称", "产品型号", "规格型号", "物料编码", "sku"],
    "brand":      ["品牌", "牌子", "brand", "商标", "厂家"],
    "category":   ["品类", "类别", "分类", "类目", "种类", "类型", "category", 
                   "二级品类", "三级品类", "一级品类", "所属分类"],
    "price":      ["价", "价格", "金额", "成本", "费用", "售价", "进价", "批发",
                   "零售", "代发", "商谈", "报价", "单价", "总价", "金额"],
    "remark":     ["备注", "说明", "注释", "附注", "描述", "remark", "note", "备注"],
    "date":       ["日期", "时间", "date", "年月日", "生产日期", "到期日", "有效期"],
    "unit":       ["单位", "数量", "个", "件", "箱", "unit", "qty", "quantity"],
}


def _score_column_match(source_norm: str, target_norm: str) -> float:
    """
    综合评分：两个标准化列名的匹配程度 (0~1)
    考虑：字符相似度、领域关键词匹配
    """
    # 精确匹配
    if source_norm == target_norm:
        return 1.0
    
    # 一方完全包含另一方
    if source_norm in target_norm or target_norm in source_norm:
        base = 0.85 * (min(len(source_norm), len(target_norm)) / max(len(source_norm), len(target_norm)))
        return base
    
    # 字符相似度
    sim = _char_similarity(source_norm, target_norm)
    
    # 领域关键词加分：如果两者属于同一领域
    for domain, keywords in _DOMAIN_KEYWORDS.items():
        src_has = any(kw in source_norm for kw in keywords)
        tgt_has = any(kw in target_norm for kw in keywords)
        if src_has and tgt_has:
            # 同一领域，大幅度加分
            sim = max(sim, 0.75)
            break
    
    # 对常见中文同义词/近义词做加分
    synonym_pairs = [
        (["商品", "产品", "品名", "货品", "物品"], ["型号", "规格", "品名", "商品名称", "产品名称"]),
        (["价格", "售价", "价钱"], ["价格", "售价", "进价", "零售价", "新进货价"]),
        (["备注", "附注"], ["备注", "说明"]),
        (["图片", "照片"], ["图片"]),
    ]
    for src_syns, tgt_syns in synonym_pairs:
        if any(s in source_norm for s in src_syns) and any(t in target_norm for t in tgt_syns):
            sim = max(sim, 0.7)
    
    return min(sim, 1.0)


def _get_mapped_targets(mappings: list) -> set:
    """从映射列表中获取已被占用的目标列名集合"""
    return {m["target_column"] for m in mappings if m.get("target_column")}


def local_match_headers(
    source_headers: list,
    target_headers: list,
    source_df=None,
    reference_df=None,
    formula_columns=None,
    prematched_sources: set = None,
    prematched_targets: set = None,
) -> list:
    """
    不使用 AI 时的本地智能列名匹配。
    
    策略（按优先级）：
    1. 特殊规则（已由 match_headers 处理）
    2. 历史映射（已由 match_headers 处理）
    3. 精确匹配（标准化后完全相同）
    4. 领域关键词 + 数据类型的综合评分匹配
    5. 字符相似度兜底
    
    每个目标列只能被一个源列匹配（一一对应）。
    """
    import pandas as pd
    
    # ── 预处理 ──
    src_norm_map = {}   # normalized → original
    for h in source_headers:
        n = _norm(h)
        if n:
            src_norm_map[n] = h
    
    tgt_norm_map = {}
    for h in target_headers:
        n = _norm(h)
        if n:
            tgt_norm_map[n] = h
    
    # 公式列不参与匹配
    formula_set = set()
    if formula_columns:
        formula_set = set(_norm(fc) for fc in formula_columns)
    
    # ── 已被上级（特殊规则/历史）匹配的列不再参与 ──
    result = []
    matched_sources = set(prematched_sources or [])
    matched_targets = set(prematched_targets or [])
    
    # ── 精确匹配（标准化后相同）──
    for src_norm, src_orig in src_norm_map.items():
        if src_orig in matched_sources:
            continue
        if src_norm in tgt_norm_map:
            tgt_orig = tgt_norm_map[src_norm]
            if tgt_orig in matched_targets:
                continue
            # 跳过公式列
            if src_norm in formula_set:
                continue
            result.append({
                "source_column": src_orig,
                "target_column": tgt_orig,
                "confidence": "high",
                "reason": "列名完全相同",
            })
            matched_sources.add(src_orig)
            matched_targets.add(tgt_orig)
    
    # ── 第 3 步：领域关键词 + 数据类型的综合评分匹配 ──
    # 先为每个目标列构建特征
    target_features = []
    for tgt_orig in target_headers:
        if tgt_orig in matched_targets:
            continue
        tgt_norm = _norm(tgt_orig)
        if not tgt_norm or tgt_norm in formula_set:
            continue
        dtype = _infer_data_type_from_header(tgt_norm)
        # 参考表是否有数据可用于类型推断
        ref_type = _column_data_type(reference_df, tgt_orig)
        target_features.append({
            "original": tgt_orig,
            "norm": tgt_norm,
            "header_type": dtype,
            "data_type": ref_type,
        })
    
    # 为每个未匹配的源列找最佳目标列
    for src_orig in source_headers:
        if src_orig in matched_sources:
            continue
        src_norm = _norm(src_orig)
        if not src_norm:
            continue
        src_header_type = _infer_data_type_from_header(src_norm)
        src_data_type = _column_data_type(source_df, src_orig)
        
        best_score = 0.0
        best_target = None
        best_reason = ""
        
        for tf in target_features:
            # 综合评分
            score = _score_column_match(src_norm, tf["norm"])
            
            # 数据类型匹配加分
            if src_header_type == tf["header_type"] and src_header_type != "text":
                score += 0.15
            if src_data_type != "empty" and tf["data_type"] != "empty" and src_data_type == tf["data_type"]:
                score += 0.1
            
            if score > best_score:
                best_score = score
                best_target = tf
                if src_header_type == tf["header_type"] and src_header_type != "text":
                    best_reason = f"列名相似 + 同属'{src_header_type}'类型"
                elif src_norm in tf["norm"] or tf["norm"] in src_norm:
                    best_reason = "列名互相包含"
                else:
                    best_reason = "列名语义相似"
        
        if best_target and best_score >= 0.5:
            # 置信度分级
            if best_score >= 0.85:
                conf = "high"
            elif best_score >= 0.7:
                conf = "medium"
            else:
                conf = "low"
            
            result.append({
                "source_column": src_orig,
                "target_column": best_target["original"],
                "confidence": conf,
                "reason": f"{best_reason} (评分: {best_score:.2f})",
            })
            matched_sources.add(src_orig)
            matched_targets.add(best_target["original"])
            # 从候选列表中移除已匹配的目标列
            target_features = [tf for tf in target_features if tf["original"] != best_target["original"]]
    
    return result


def merge_mappings(special_mappings: list, ai_mappings: list) -> list:
    """合并特殊规则映射和AI映射，特殊规则优先"""
    merged = list(special_mappings)  # 特殊规则放前面
    
    # 已匹配的源列和目标列
    matched_sources = {m["source_column"] for m in special_mappings}
    matched_targets = {m["target_column"] for m in special_mappings}
    
    for m in ai_mappings:
        src = m.get("source_column", "")
        tgt = m.get("target_column", "")
        
        # 跳过已由特殊规则匹配的源列
        if src in matched_sources:
            continue
        
        # 跳过目标列为null的情况
        if tgt is None or tgt == "null" or tgt == "":
            continue
        
        merged.append(m)
        matched_sources.add(src)
        matched_targets.add(tgt)
    
    return merged


def _norm_header(h: str) -> str:
    """标准化列名，用于匹配查找"""
    if h is None:
        return ""
    return str(h).replace('\n', '').replace('\r', '').strip().lower()


def _apply_history_mappings(
    source_headers: list,
    target_headers: list,
    history_dict: dict,
    matched_sources: set,
    matched_targets: set,
) -> list:
    """
    应用历史映射记录，返回新增的映射列表。
    历史记录的优先级介于特殊规则和 AI/本地匹配之间。
    """
    result = []
    
    # 构建标准化目标列名查找表
    tgt_norm_map = {}  # normalized → original
    for h in target_headers:
        n = _norm_header(h)
        if n:
            tgt_norm_map[n] = h
    
    for src_orig in source_headers:
        if src_orig in matched_sources:
            continue
        src_norm = _norm_header(src_orig)
        if not src_norm:
            continue
        
        # 在历史记录中查找（先精确匹配列名，再尝试模糊匹配）
        hist_tgt = None
        for hist_src_norm, hist_tgt_norm in history_dict.items():
            if hist_src_norm == src_norm:
                hist_tgt = hist_tgt_norm
                break
        
        if not hist_tgt:
            continue
        
        # 在目标表头中查找该目标列是否存在
        best_tgt = None
        for tgt_orig in target_headers:
            tgt_norm = _norm_header(tgt_orig)
            if tgt_orig in matched_targets:
                continue
            if tgt_norm == hist_tgt or hist_tgt in tgt_norm or tgt_norm in hist_tgt:
                best_tgt = tgt_orig
                # 优先精确匹配，不精确匹配则继续找更接近的
                if tgt_norm == hist_tgt:
                    break
        
        if best_tgt:
            result.append({
                "source_column": src_orig,
                "target_column": best_tgt,
                "confidence": "high",
                "reason": f"历史记录: 用户之前将'{src_orig}'映射到'{best_tgt}'",
            })
            matched_sources.add(src_orig)
            matched_targets.add(best_tgt)
    
    return result


def match_headers(
    source_headers: list,
    target_headers: list,
    sample_data: str = "",
    use_ai: bool = True,
    source_df=None,
    reference_df=None,
    reference_headers=None,
    formula_columns=None,
) -> list:
    """
    将源表列名智能匹配到目标表列名
    
    Args:
        source_headers: 源表列名列表
        target_headers: 目标表列名列表
        sample_data: 源表前几行示例数据（兼容旧参数，新逻辑使用 source_df）
        use_ai: 是否使用AI进行匹配
        source_df: 源表 DataFrame（用于逐列数据采样）
        reference_df: 参考表 DataFrame（用于逐列数据采样）
        reference_headers: 参考表列名列表
    
    Returns:
        映射列表 [{"source_column": ..., "target_column": ..., "confidence": ..., "reason": ...}, ...]
    """
    # 第 0 步：加载历史映射记录（用户之前手动调整过的映射）
    history_dict = get_history_mappings_dict()
    if history_dict:
        print(f"  📖 加载了 {len(history_dict)} 条历史映射记录")
    
    # 第 1 步：应用特殊硬编码规则（优先级最高）
    special_mappings = apply_special_mappings(source_headers, target_headers)
    
    # 已匹配的源列和目标列（后续步骤不得冲突）
    matched_sources = {m["source_column"] for m in special_mappings}
    matched_targets = {m["target_column"] for m in special_mappings}
    
    # 第 2 步：应用历史映射记录（优先级第二，高于 AI/本地匹配）
    history_mappings = _apply_history_mappings(
        source_headers, target_headers, history_dict,
        matched_sources, matched_targets,
    )
    
    if not use_ai:
        # 使用本地智能匹配（含特殊规则 + 历史记录 + 精确匹配 + 领域关键词 + 数据类型推断）
        local_mappings = local_match_headers(
            source_headers, target_headers,
            source_df=source_df,
            reference_df=reference_df,
            formula_columns=formula_columns,
            prematched_sources=matched_sources,
            prematched_targets=matched_targets,
        )
        return special_mappings + history_mappings + local_mappings
    
    # 第 3 步：调用AI进行智能匹配（含逐列数据采样）
    prompt = build_matching_prompt(
        source_headers, target_headers,
        source_df=source_df,
        reference_df=reference_df,
        reference_headers=reference_headers,
        formula_columns=formula_columns,
    )
    
    try:
        response = call_deepseek_api(prompt, max_tokens=8192)
        ai_result = extract_json_from_response(response)
        ai_mappings = ai_result.get("mappings", [])
        
        # 打印AI的匹配说明
        notes = ai_result.get("notes", "")
        if notes:
            try:
                print(f"  AI匹配说明: {notes}")
            except UnicodeEncodeError:
                print(f"  AI 匹配说明: 成功")
        
    except Exception as e:
        try:
            print(f"  ! AI匹配失败: {e}")
        except UnicodeEncodeError:
            print(f"  ! AI 匹配失败")
        print(f"  将降级使用本地匹配")
        ai_mappings = []
    
    # 第 4 步：合并结果（去重，历史记录和特殊规则优先）
    # 从 ai_mappings 中过滤掉已被特殊规则或历史记录匹配的列
    filtered_ai = []
    for m in ai_mappings:
        src = m.get("source_column", "")
        tgt = m.get("target_column", "")
        if src in matched_sources:
            continue
        if tgt is None or tgt == "null" or tgt == "":
            continue
        if tgt in matched_targets:
            continue
        filtered_ai.append(m)
        matched_sources.add(src)
        matched_targets.add(tgt)
    
    final_mappings = special_mappings + history_mappings + filtered_ai
    
    return final_mappings


if __name__ == "__main__":
    # 简单测试
    source = ["序号", "产品", "品名", "图片", "大客户代发价  【已加2%】", "备注"]
    target = ["序号", "图片", "快查型号", "型号", "商品名称", "品牌", "二级品类", 
              "三级品类", "备货\n商谈价", "新进货价", "零售价", "备注"]
    
    print("源表列名:", source)
    print("目标表列名:", target)
    print()
    
    mappings = match_headers(source, target, use_ai=True)
    print("\n匹配结果:")
    for m in mappings:
        print(f"  {m['source_column']} → {m['target_column']} ({m['confidence']}) - {m['reason']}")
