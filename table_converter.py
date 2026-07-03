"""
表格转换核心模块
负责读取原始表格和参考表格，执行列映射和数据转换
"""

import pandas as pd
import openpyxl
from openpyxl.utils import get_column_letter, column_index_from_string
from openpyxl.styles import Font, Alignment, Border, Side, PatternFill
from openpyxl.drawing.image import Image as OpenpyxlImage
import os
import re
import io
import zipfile
from copy import copy
from typing import Optional

from config import (
    REFERENCE_FILE,
    OUTPUT_DIR,
    FORMULA_COLUMNS,
    SKIP_TARGET_COLUMNS,
    MARGIN_RATE,
    MARGIN_COLUMNS,
)
from deepseek_matcher import match_headers


def normalize_header(header: str) -> str:
    """标准化表头字符串，去掉换行符和多余空格"""
    if pd.isna(header):
        return ""
    return str(header).replace('\n', '').replace('\r', '').strip()


def read_reference_template(file_path: str):
    """
    读取参考表格模板，提取：
    - 表头行
    - 公式信息（哪些列有公式，公式内容是什么）
    - 列宽、样式等格式信息
    
    Returns:
        dict: {
            'headers': list of header strings,
            'header_row_idx': header row index (1-based),
            'formula_info': dict mapping col_letter -> formula string,
            'column_widths': dict mapping col_letter -> width,
            'styles': style info
        }
    """
    # 使用 openpyxl 读取以保留公式
    wb = openpyxl.load_workbook(file_path)
    ws = wb.active
    
    # 确定表头行（第一行非空行）
    header_row_idx = 1
    headers = []
    for col_idx in range(1, ws.max_column + 1):
        cell = ws.cell(row=header_row_idx, column=col_idx)
        headers.append(normalize_header(str(cell.value) if cell.value is not None else ""))
    
    # 读取第二行（数据示例行）的公式和固定值
    formula_info = {}       # 公式列: col_letter → formula_string
    fixed_values = {}       # 固定值列: col_letter → value (非公式、非None)
    data_row_idx = header_row_idx + 1
    for col_idx in range(1, ws.max_column + 1):
        cell = ws.cell(row=data_row_idx, column=col_idx)
        col_letter = get_column_letter(col_idx)
        if cell.value is not None:
            val_str = str(cell.value)
            if val_str.startswith('='):
                formula_info[col_letter] = val_str
            else:
                fixed_values[col_letter] = cell.value
    
    # 分析公式引用了哪些列（用于确定哪些固定值是公式依赖的）
    formula_dependencies = set()
    for formula in formula_info.values():
        # 提取公式中的列引用，如 L2, AF2, N2 等
        refs = re.findall(r'([A-Z]+)(\d+)', formula)
        for col_letter, row_num in refs:
            formula_dependencies.add(col_letter)
    
    # 读取列宽
    column_widths = {}
    for col_idx in range(1, ws.max_column + 1):
        col_letter = get_column_letter(col_idx)
        if col_letter in ws.column_dimensions:
            column_widths[col_letter] = ws.column_dimensions[col_letter].width
    
    # 读取第一行的样式作为表头样式
    header_styles = {}
    for col_idx in range(1, ws.max_column + 1):
        cell = ws.cell(row=header_row_idx, column=col_idx)
        col_letter = get_column_letter(col_idx)
        header_styles[col_letter] = {
            'font': copy(cell.font) if cell.font else None,
            'alignment': copy(cell.alignment) if cell.alignment else None,
            'fill': copy(cell.fill) if cell.fill else None,
            'border': copy(cell.border) if cell.border else None,
        }
    
    # 读取数据行的样式作为数据样式模板
    data_styles = {}
    for col_idx in range(1, ws.max_column + 1):
        cell = ws.cell(row=data_row_idx, column=col_idx)
        col_letter = get_column_letter(col_idx)
        data_styles[col_letter] = {
            'font': copy(cell.font) if cell.font else None,
            'alignment': copy(cell.alignment) if cell.alignment else None,
            'fill': copy(cell.fill) if cell.fill else None,
            'border': copy(cell.border) if cell.border else None,
            'number_format': cell.number_format,
        }
    
    wb.close()
    
    return {
        'headers': headers,
        'header_row_idx': header_row_idx,
        'formula_info': formula_info,
        'fixed_values': fixed_values,
        'formula_dependencies': formula_dependencies,
        'column_widths': column_widths,
        'header_styles': header_styles,
        'data_styles': data_styles,
        'max_column': ws.max_column,
    }


def read_source_file(file_path: str):
    """
    读取原始表格文件，自动处理表头行
    
    Returns:
        tuple: (DataFrame, headers_list)
    """
    # 先尝试读取，不指定header
    df_raw = pd.read_excel(file_path, header=None, dtype=object)
    
    # 查找表头行（第一行非全空且有内容的行）
    header_row = 0
    for i in range(min(5, len(df_raw))):
        row_values = df_raw.iloc[i].tolist()
        non_null = sum(1 for v in row_values if not pd.isna(v) and str(v).strip() != '')
        if non_null >= 2:  # 至少有2个非空值认为是表头
            header_row = i
            break
    
    # 使用找到的表头行重新读取
    df = pd.read_excel(file_path, header=header_row, dtype=object)
    
    # 清理列名
    df.columns = [normalize_header(c) for c in df.columns]
    
    # 删除全空行
    df = df.dropna(how='all')
    
    # 重置索引
    df = df.reset_index(drop=True)
    
    headers = [normalize_header(c) for c in df.columns]
    
    return df, headers


def build_header_to_col_index(headers: list) -> dict:
    """构建表头名到列索引的映射（处理重复列名）"""
    mapping = {}
    for idx, header in enumerate(headers):
        clean = normalize_header(header)
        if clean:
            # 如果已存在同名列，保留第一个的映射
            if clean not in mapping:
                mapping[clean] = idx
    return mapping


def find_target_column(target_headers: list, target_col_name: str) -> Optional[int]:
    """在目标表头列表中查找匹配的列索引"""
    target_clean = normalize_header(target_col_name)
    
    # 首先精确匹配
    for idx, h in enumerate(target_headers):
        if normalize_header(h) == target_clean:
            return idx
    
    # 模糊匹配：目标列名包含在表头中
    for idx, h in enumerate(target_headers):
        h_clean = normalize_header(h)
        if target_clean in h_clean or h_clean in target_clean:
            return idx
    
    return None


def extract_images_from_source(source_path: str) -> dict:
    """
    从源文件中提取DISPIMG嵌入的图片
    
    支持两种格式：
    1. .xlsx: 解析 worksheet XML 找 DISPIMG 单元格位置
    2. .xls (OpenXML包装): 通过 pandas 读取 DISPIMG 值 + zip 提取图片
    
    Returns:
        dict: {(row_idx, col_idx): bytes} 行列均为0-based（数据行，不含表头偏移）
    """
    images_map = {}
    ext = os.path.splitext(source_path)[1].lower()
    
    try:
        with zipfile.ZipFile(source_path, 'r') as z:
            # Step 1: 解析 cellimages.xml.rels → rId → image file（大小写不敏感）
            rid_to_file = {}
            for name in z.namelist():
                if 'cellimages.xml.rels' in name.lower():
                    rels_xml = z.read(name).decode('utf-8')
                    for m in re.finditer(r'Id="(rId\d+)"[^>]*Target="([^"]+)"', rels_xml):
                        rid_to_file[m.group(1)] = m.group(2)
                    break
            
            if not rid_to_file:
                return images_map
            
            # Step 2: 解析 cellimages.xml → GUID name → rId（大小写不敏感）
            guid_to_rid = {}
            for name in z.namelist():
                if name.lower().endswith('cellimages.xml') and 'rels' not in name.lower():
                    try:
                        ci_xml = z.read(name).decode('utf-8')
                        for m in re.finditer(
                            r'<xdr:cNvPr[^>]*name="(ID_[^"]+)"[^>]*>.*?<a:blip r:embed="(rId\d+)"',
                            ci_xml, re.DOTALL
                        ):
                            guid_to_rid[m.group(1)] = m.group(2)
                    except Exception:
                        pass
                    break
            
            # Step 3: 用 pandas 读取 DISPIMG 位置（最可靠的方式）
            dispimg_positions = []  # [(row_idx_0based, col_idx_0based, guid)]
            try:
                df_raw = pd.read_excel(source_path, header=None, dtype=object)
                header_row = 0
                for i in range(min(5, len(df_raw))):
                    row_vals = df_raw.iloc[i].tolist()
                    non_null = sum(1 for v in row_vals if not pd.isna(v) and str(v).strip() != '')
                    if non_null >= 2:
                        header_row = i
                        break
                
                for r in range(header_row + 1, len(df_raw)):
                    for c in range(len(df_raw.columns)):
                        val = df_raw.iloc[r, c]
                        if pd.notna(val) and 'DISPIMG' in str(val):
                            guid_match = re.search(r'ID_([A-F0-9]+)', str(val))
                            if guid_match:
                                guid = 'ID_' + guid_match.group(1)
                                row_idx = r - header_row - 1
                                col_idx = c
                                dispimg_positions.append((row_idx, col_idx, guid))
            except Exception:
                pass
            
            # Step 4: 提取图片数据
            # 如果没有 guid_to_rid 映射（cellImages.xml损坏），按行顺序匹配
            if not guid_to_rid and dispimg_positions:
                sorted_rids = sorted(rid_to_file.keys(), key=lambda x: int(x[3:]) if x[3:].isdigit() else 0)
                for i, (row_idx, col_idx, guid) in enumerate(dispimg_positions):
                    if i < len(sorted_rids):
                        guid_to_rid[guid] = sorted_rids[i]
            
            for row_idx, col_idx, guid in dispimg_positions:
                if row_idx < 0:
                    continue
                rid = guid_to_rid.get(guid, '')
                image_file = rid_to_file.get(rid, '')
                if not image_file:
                    continue
                
                full_path = 'xl/' + image_file if not image_file.startswith('xl/') else image_file
                if full_path not in z.namelist():
                    continue
                
                try:
                    image_data = z.read(full_path)
                    images_map[(row_idx, col_idx)] = image_data
                except Exception:
                    continue
    
    except Exception:
        pass
    
    return images_map


def convert_table(
    source_file: str,
    reference_file: str = REFERENCE_FILE,
    output_file: Optional[str] = None,
    use_ai: bool = True,
    verbose: bool = True,
) -> str:
    """
    将原始表格转换为参考表格格式
    
    Args:
        source_file: 原始表格文件路径
        reference_file: 参考表格（模板）文件路径
        output_file: 输出文件路径（可选，默认自动生成）
        use_ai: 是否使用AI进行列匹配
        verbose: 是否打印详细信息
    
    Returns:
        str: 输出文件路径
    """
    source_name = os.path.splitext(os.path.basename(source_file))[0]
    
    if verbose:
        print(f"\n{'='*60}")
        print(f"📄 处理文件: {source_name}")
        print(f"{'='*60}")
    
    # ========== 第一步：读取参考模板 ==========
    if verbose:
        print("  读取参考模板...")
    template = read_reference_template(reference_file)
    target_headers = template['headers']
    formula_info = template['formula_info']
    fixed_values = template['fixed_values']
    formula_deps = template['formula_dependencies']
    
    if verbose:
        print(f"  参考模板: {len(target_headers)} 列, {len(formula_info)} 个公式列, {len(fixed_values)} 个固定值列")
    
    # ========== 第二步：读取原始表格 ==========
    if verbose:
        print("  读取原始表格...")
    source_df, source_headers = read_source_file(source_file)
    
    if verbose:
        print(f"  原始表格: {len(source_df)} 行, {len(source_headers)} 列")
        print(f"  原始列名: {source_headers}")
    
    # 检查是否两表列数相同且列名相似 → 可能已是参考格式
    same_format = (
        len(source_headers) == len(target_headers) and
        sum(1 for sh in source_headers if any(
            normalize_header(sh) == normalize_header(th) for th in target_headers
        )) >= len(source_headers) * 0.7  # 70%列名匹配
    )
    
    if same_format and verbose:
        print("  ℹ 检测到原始表格与参考格式高度相似，将直接复制数据并填充公式列")
    
    # ========== 第三步：列名匹配 ==========
    if same_format:
        # 已是相同格式，直接按位置一一对应
        column_mapping = {}
        for i, sh in enumerate(source_headers):
            if i < len(target_headers):
                column_mapping[sh] = i
    else:
        if verbose:
            print("  🤖 调用DeepSeek AI进行列名智能匹配...")
        
        # 准备示例数据
        sample_rows = source_df.head(3).to_string(index=False)
        
        # 执行匹配
        mappings = match_headers(
            source_headers=source_headers,
            target_headers=target_headers,
            sample_data=sample_rows,
            use_ai=use_ai,
        )
        
        if verbose:
            print(f"\n  匹配结果 ({len(mappings)} 项):")
            for m in mappings:
                conf_icon = {"high": "✅", "medium": "⚠️", "low": "❓"}.get(m['confidence'], '  ')
                print(f"    {conf_icon} [{m['confidence']}] {m['source_column']} → {m['target_column']}")
                if 'reason' in m and m['reason']:
                    print(f"       理由: {m['reason']}")
        
        # 构建列映射：源列索引 → 目标列索引
        column_mapping = {}
        for m in mappings:
            src_col = m['source_column']
            tgt_col = m['target_column']
            
            # 查找源列索引
            src_idx = None
            for i, h in enumerate(source_headers):
                if normalize_header(h) == normalize_header(src_col):
                    src_idx = i
                    break
            
            # 查找目标列索引
            tgt_idx = find_target_column(target_headers, tgt_col)
            
            if src_idx is not None and tgt_idx is not None:
                column_mapping[src_col] = tgt_idx
    
    # 打印列映射详情
    if verbose:
        print(f"\n  最终列映射 ({len(column_mapping)} 项):")
        for src_col, tgt_idx in column_mapping.items():
            if tgt_idx < len(target_headers):
                print(f"    {src_col} → [{tgt_idx}] {target_headers[tgt_idx]}")
    
    # ========== 第四步：构建输出工作簿 ==========
    if verbose:
        print("\n  📝 生成输出文件...")
    
    # 创建输出工作簿
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Sheet1"
    
    num_target_cols = template['max_column']
    
    # ========== 第五步：写入表头 ==========
    for col_idx in range(1, num_target_cols + 1):
        cell = ws.cell(row=1, column=col_idx)
        cell.value = target_headers[col_idx - 1]
        
        # 应用表头样式
        col_letter = get_column_letter(col_idx)
        if col_letter in template['header_styles']:
            styles = template['header_styles'][col_letter]
            if styles.get('font'):
                cell.font = styles['font']
            if styles.get('alignment'):
                cell.alignment = styles['alignment']
            if styles.get('fill'):
                cell.fill = styles['fill']
            if styles.get('border'):
                cell.border = styles['border']
    
    # ========== 第六步：写入数据行 ==========
    num_written = 0
    for src_row_idx in range(len(source_df)):
        output_row = src_row_idx + 2  # 从第2行开始（第1行是表头）
        
        # --- 第一遍：先写入源数据映射的值 ---
        for col_idx in range(1, num_target_cols + 1):
            cell = ws.cell(row=output_row, column=col_idx)
            col_letter = get_column_letter(col_idx)
            
            # 应用数据样式
            if col_letter in template['data_styles']:
                styles = template['data_styles'][col_letter]
                if styles.get('font'):
                    cell.font = styles['font']
                if styles.get('alignment'):
                    cell.alignment = styles['alignment']
                if styles.get('fill'):
                    cell.fill = styles['fill']
                if styles.get('border'):
                    cell.border = styles['border']
                if styles.get('number_format'):
                    cell.number_format = styles['number_format']
            
            # 查找此目标列是否有对应的源列映射
            src_col_idx = None
            for src_col_name, tgt_idx in column_mapping.items():
                if tgt_idx == col_idx - 1:  # col_idx is 1-based, tgt_idx is 0-based
                    for i, h in enumerate(source_headers):
                        if normalize_header(h) == normalize_header(src_col_name):
                            src_col_idx = i
                            break
                    break
            
            if src_col_idx is not None and src_col_idx < len(source_df.columns):
                val = source_df.iloc[src_row_idx, src_col_idx]
                if pd.notna(val):
                    val_str = str(val)
                    # 跳过图片的DISPIMG公式
                    if val_str.startswith('=DISPIMG'):
                        cell.value = None
                    else:
                        try:
                            # 尝试转为数字以保留数值类型
                            if isinstance(val, str) and val_str.strip() == '':
                                cell.value = None
                            elif isinstance(val, (int, float)):
                                # 四舍五入到合理精度，避免浮点误差
                                if isinstance(val, float):
                                    rounded = round(val, 6)
                                    if rounded == int(rounded):
                                        cell.value = int(rounded)
                                    else:
                                        cell.value = rounded
                                else:
                                    cell.value = val
                            else:
                                # 尝试转换字符串为数字
                                cleaned = val_str.replace(',', '').strip()
                                if cleaned.replace('.', '').replace('-', '').isdigit():
                                    num_val = float(cleaned)
                                    rounded = round(num_val, 6)
                                    if rounded == int(rounded):
                                        cell.value = int(rounded)
                                    else:
                                        cell.value = rounded
                                else:
                                    cell.value = val
                        except (ValueError, TypeError):
                            cell.value = val
        
        # --- 第二遍：写入公式列（覆盖可能被源数据填充的公式列） ---
        for col_idx in range(1, num_target_cols + 1):
            col_letter = get_column_letter(col_idx)
            if col_letter in formula_info:
                cell = ws.cell(row=output_row, column=col_idx)
                formula = formula_info[col_letter]
                adjusted_formula = adjust_formula_row(formula, output_row)
                cell.value = adjusted_formula
        
        # --- 第三遍：写入统一毛利率配置值 ---
        # 所有毛利率列统一使用配置的 MARGIN_RATE（默认10%），覆盖公式
        for col_idx in range(1, num_target_cols + 1):
            col_letter = get_column_letter(col_idx)
            cell = ws.cell(row=output_row, column=col_idx)
            
            # 毛利率列：强制写入统一配置值（即使之前有公式也覆盖）
            if col_letter in MARGIN_COLUMNS:
                cell.value = MARGIN_RATE
                continue
            
            # 如果单元格已经有值（来自源数据），跳过
            if cell.value is not None:
                continue
            
            # 其他被公式引用的固定值常量（百分比类），写入参考默认值
            if col_letter in formula_deps and col_letter in fixed_values:
                val = fixed_values[col_letter]
                if isinstance(val, (int, float)) and 0 < val < 1:
                    cell.value = val
        
        num_written += 1
    
    # ========== 第六步半：插入图片 ==========
    # 提取源文件中的嵌入图片
    images_map = extract_images_from_source(source_file)
    if images_map and verbose:
        print(f"  🖼️ 检测到 {len(images_map)} 张嵌入图片，正在复制...")
    
    # 找到源文件"图片"列映射到目标哪一列
    target_img_col = None
    source_img_col = None
    for src_col_name, tgt_idx in column_mapping.items():
        if '图片' in normalize_header(src_col_name):
            source_img_col = None
            for i, h in enumerate(source_headers):
                if normalize_header(h) == normalize_header(src_col_name):
                    source_img_col = i
                    break
            target_img_col = tgt_idx
            break
    
    if images_map and source_img_col is not None and target_img_col is not None:
        inserted = 0
        for (src_row, src_col), img_data in images_map.items():
            if src_col == source_img_col and src_row < len(source_df):
                try:
                    img_stream = io.BytesIO(img_data)
                    img = OpenpyxlImage(img_stream)
                    # 缩放图片适应单元格（最大宽度120px，高度按比例）
                    max_width_px = 120
                    if img.width > max_width_px:
                        ratio = max_width_px / img.width
                        img.width = max_width_px
                        img.height = int(img.height * ratio)
                    
                    # 目标位置：Excel行号 = src_row + 2 (0-based data + 1 header + 1 Excel 1-based)
                    target_row = src_row + 2
                    target_col_letter = get_column_letter(target_img_col + 1)
                    cell_ref = f"{target_col_letter}{target_row}"
                    ws.add_image(img, cell_ref)
                    inserted += 1
                except Exception:
                    pass
        if verbose:
            print(f"  ✅ 成功插入 {inserted} 张图片")
    
    # ========== 第七步：设置列宽 ==========
    for col_idx in range(1, num_target_cols + 1):
        col_letter = get_column_letter(col_idx)
        if col_letter in template['column_widths'] and template['column_widths'][col_letter]:
            ws.column_dimensions[col_letter].width = template['column_widths'][col_letter]
    
    # ========== 第八步：保存输出文件 ==========
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    
    if output_file is None:
        output_file = os.path.join(OUTPUT_DIR, f"{source_name}_转换结果.xlsx")
    
    wb.save(output_file)
    wb.close()
    
    if verbose:
        print(f"  ✅ 成功! 共写入 {num_written} 行数据")
        print(f"  📁 输出文件: {output_file}")
    
    return output_file


def adjust_formula_row(formula: str, target_row: int) -> str:
    """
    调整Excel公式中的行号引用
    
    参考模板中的公式引用的是第2行（模板数据行），
    需要将所有行号引用调整为 target_row
    
    例如: "=D2&\" - 浦升\"" → "=D5&\" - 浦升\""
    """
    # 匹配单元格引用模式 (列字母+行号)
    def replace_row(match):
        col_letter = match.group(1)
        row_num = int(match.group(2))
        # 只有当行号为2（模板行）时才调整
        if row_num == 2:
            return f"{col_letter}{target_row}"
        return match.group(0)
    
    # 匹配模式：一个或多个大写字母后跟数字
    adjusted = re.sub(r'([A-Z]+)(\d+)', replace_row, formula)
    return adjusted


def batch_convert(
    source_files: list,
    reference_file: str = REFERENCE_FILE,
    use_ai: bool = True,
) -> list:
    """
    批量转换多个原始表格
    
    Args:
        source_files: 原始表格文件路径列表
        reference_file: 参考表格路径
        use_ai: 是否使用AI
    
    Returns:
        list: 输出文件路径列表
    """
    output_files = []
    total = len(source_files)
    
    print(f"\n{'#'*60}")
    print(f"🚀 开始批量转换 {total} 个文件")
    print(f"{'#'*60}")
    
    for i, src_file in enumerate(source_files, 1):
        print(f"\n[{i}/{total}] 处理中...")
        try:
            output = convert_table(
                source_file=src_file,
                reference_file=reference_file,
                use_ai=use_ai,
                verbose=True,
            )
            output_files.append(output)
        except Exception as e:
            print(f"  ❌ 处理失败: {e}")
            import traceback
            traceback.print_exc()
    
    print(f"\n{'#'*60}")
    print(f"📊 转换完成: {len(output_files)}/{total} 成功")
    print(f"📁 输出目录: {OUTPUT_DIR}")
    print(f"{'#'*60}")
    
    return output_files


if __name__ == "__main__":
    # 测试单个文件转换
    from config import SOURCE_FILES
    
    convert_table(
        source_file=SOURCE_FILES[0],
        reference_file=REFERENCE_FILE,
        use_ai=True,
    )
