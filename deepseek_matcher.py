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
    SKIP_TARGET_COLUMNS,
)


def call_deepseek_api(prompt: str, max_tokens: int = 2000) -> str:
    """调用 DeepSeek API 并返回回复内容"""
    headers = {
        "Authorization": f"Bearer {DEEPSEEK_API_KEY}",
        "Content-Type": "application/json",
    }
    
    payload = {
        "model": DEEPSEEK_MODEL,
        "messages": [
            {"role": "system", "content": "你是一个专业的Excel表格列名匹配专家。请严格按照JSON格式返回结果。"},
            {"role": "user", "content": prompt},
        ],
        "max_tokens": max_tokens,
        "temperature": 0.1,  # 低温度以获得更确定性的结果
    }
    
    try:
        response = requests.post(DEEPSEEK_API_URL, headers=headers, json=payload, timeout=60)
        response.raise_for_status()
        result = response.json()
        content = result["choices"][0]["message"]["content"]
        return content
    except requests.exceptions.Timeout:
        raise RuntimeError("DeepSeek API 请求超时，请检查网络连接")
    except requests.exceptions.RequestException as e:
        raise RuntimeError(f"DeepSeek API 请求失败: {e}")
    except (KeyError, IndexError) as e:
        raise RuntimeError(f"DeepSeek API 返回格式异常: {e}\n原始返回: {result if 'result' in dir() else 'N/A'}")


def extract_json_from_response(response: str) -> dict:
    """从API响应中提取JSON"""
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
    
    # 尝试找到第一个 { 到最后一个 }
    start = response.find('{')
    end = response.rfind('}')
    if start != -1 and end != -1:
        try:
            return json.loads(response[start:end + 1])
        except json.JSONDecodeError:
            pass
    
    raise RuntimeError(f"无法从API响应中提取JSON:\n{response[:500]}")


def build_matching_prompt(source_headers: list, target_headers: list, sample_data: str) -> str:
    """构建列名匹配的提示词"""
    # 过滤掉目标表中的公式列
    filtered_target = [
        h for h in target_headers 
        if not any(skip in str(h).replace('\n', '') for skip in SKIP_TARGET_COLUMNS)
    ]
    
    return HEADER_MATCHING_PROMPT.format(
        target_count=len(filtered_target),
        target_headers=json.dumps(filtered_target, ensure_ascii=False, indent=2),
        source_count=len(source_headers),
        source_headers=json.dumps(source_headers, ensure_ascii=False, indent=2),
        sample_data=sample_data,
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


def match_headers(
    source_headers: list,
    target_headers: list,
    sample_data: str = "",
    use_ai: bool = True,
) -> list:
    """
    将源表列名智能匹配到目标表列名
    
    Args:
        source_headers: 源表列名列表
        target_headers: 目标表列名列表
        sample_data: 源表前几行示例数据（用于AI理解列含义）
        use_ai: 是否使用AI进行匹配
    
    Returns:
        映射列表 [{"source_column": ..., "target_column": ..., "confidence": ..., "reason": ...}, ...]
    """
    # 第一步：应用特殊硬编码规则
    special_mappings = apply_special_mappings(source_headers, target_headers)
    
    if not use_ai:
        return special_mappings
    
    # 第二步：调用AI进行智能匹配
    prompt = build_matching_prompt(source_headers, target_headers, sample_data)
    
    try:
        response = call_deepseek_api(prompt)
        ai_result = extract_json_from_response(response)
        ai_mappings = ai_result.get("mappings", [])
        
        # 打印AI的匹配说明
        notes = ai_result.get("notes", "")
        if notes:
            print(f"  AI匹配说明: {notes}")
        
    except Exception as e:
        print(f"  ⚠ AI匹配失败: {e}")
        print(f"  将仅使用特殊规则进行匹配")
        ai_mappings = []
    
    # 第三步：合并结果
    final_mappings = merge_mappings(special_mappings, ai_mappings)
    
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
