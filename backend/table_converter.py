"""
表格转换核心模块
负责读取原始表格和参考表格，执行列映射和数据转换
"""

import pandas as pd
import openpyxl
from openpyxl.utils import get_column_letter
# 样式通过 copy(cell.*) 继承，无需显式导入
from openpyxl.drawing.image import Image as OpenpyxlImage
import os
import re
import io
import zipfile
from copy import copy
from typing import Optional

try:
    from lxml import etree as _lxml_etree
    _HAS_LXML = True
except ImportError:
    _HAS_LXML = False

from config import (
    REFERENCE_FILE,
    OUTPUT_DIR,
    MARGIN_RATE,
    IMAGE_ROW_HEIGHT_PT,
    IMAGE_MARGIN_PT,
)
from deepseek_matcher import match_headers


def get_formula_headers(template: dict) -> list:
    """从参考模板中提取公式列的列名列表"""
    if not template or 'formula_info' not in template:
        return []
    formula_col_letters = set(template['formula_info'].keys())
    headers = template.get('headers', [])
    result = []
    for idx, h in enumerate(headers):
        col_letter = get_column_letter(idx + 1)
        if col_letter in formula_col_letters:
            result.append(normalize_header(h))
    return result


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
        tuple: (DataFrame, headers_list, header_row)
               header_row: 检测到的表头行号（0-based），供 extract_images_from_source 使用
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
    
    return df, headers, header_row


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


def _build_raw_to_df_map(source_path: str, header_row: int) -> dict:
    """
    构建原始Excel行号到DataFrame行索引的映射。
    
    模拟 read_source_file 中的 dropna(how='all') 逻辑，
    跳过全空行，确保图片行索引与 DataFrame 行索引对齐。
    
    Returns:
        dict: {raw_row: df_row_idx}  raw_row 是 0-based 的原始Excel行号
    """
    raw_to_df = {}
    try:
        df_raw = pd.read_excel(source_path, header=None, dtype=object)
        df_row_idx = 0
        for r in range(header_row + 1, len(df_raw)):
            row_vals = df_raw.iloc[r].tolist()
            is_empty = all(pd.isna(v) or str(v).strip() == '' for v in row_vals)
            raw_to_df[r] = df_row_idx
            if not is_empty:
                df_row_idx += 1
    except Exception:
        pass
    return raw_to_df


def _parse_drawing_rel_path(drawing_xml_path: str) -> str:
    """根据 drawing XML 路径推导对应的 rels 文件路径"""
    parts = drawing_xml_path.split('/')
    # xl/drawings/drawing1.xml → xl/drawings/_rels/drawing1.xml.rels
    return '/'.join(parts[:-1]) + '/_rels/' + parts[-1] + '.rels'


def extract_images_from_source(source_path: str, header_row: int = None) -> dict:
    """
    从源文件中提取嵌入的图片（同时支持 cellImages 和 drawings 两种格式）
    
    支持三种图片存储方式：
    1. cellImages 格式（DISPIMG公式）：解析 cellImages.xml 获取位置
    2. drawings 格式（浮动图片）：使用 lxml 解析 xl/drawings/drawing*.xml 获取锚点位置
    3. .xls (OpenXML包装)：通过 pandas 读取 DISPIMG 值 + zip 提取图片
    
    Args:
        source_path: 源文件路径
        header_row: 外部传入的表头行号（0-based），如果为None则自动检测。
    
    Returns:
        dict: {(df_row_idx, col_idx): image_data_bytes}
              df_row_idx: 0-based，对齐 read_source_file 返回的 DataFrame 行索引
              col_idx: 0-based 列索引
    """
    images_map = {}
    
    try:
        with zipfile.ZipFile(source_path, 'r') as z:
            all_names = set(z.namelist())  # 用 set 加速查找
            
            # ============================================================
            # 检测表头行（如果外部未传入）
            # ============================================================
            if header_row is None:
                header_row = 0
                try:
                    df_raw = pd.read_excel(source_path, header=None, dtype=object)
                    for i in range(min(5, len(df_raw))):
                        row_vals = df_raw.iloc[i].tolist()
                        non_null = sum(1 for v in row_vals if not pd.isna(v) and str(v).strip() != '')
                        if non_null >= 2:
                            header_row = i
                            break
                except Exception:
                    pass
            
            # ============================================================
            # 构建 raw_row → df_row_idx 映射（模拟 dropna(how='all')）
            # ============================================================
            raw_to_df = _build_raw_to_df_map(source_path, header_row)
            
            # ============================================================
            # 方式1: cellImages 格式 (DISPIMG)
            # ============================================================
            has_cell_images = any('cellimage' in n.lower() for n in all_names)
            
            if has_cell_images:
                # Step 1a: 解析 cellimages.xml.rels → rId → image file
                ci_rid_to_file = {}
                for name in all_names:
                    if 'cellimages.xml.rels' in name.lower():
                        try:
                            rels_xml = z.read(name).decode('utf-8')
                            for m in re.finditer(r'Id="(rId\d+)"[^>]*Target="([^"]+)"', rels_xml):
                                ci_rid_to_file[m.group(1)] = m.group(2)
                        except Exception:
                            pass
                        break
                
                # Step 1b: 解析 cellimages.xml → GUID name → rId
                guid_to_rid = {}
                for name in all_names:
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
                
                if ci_rid_to_file:
                    # Step 1c: 用 pandas 读取 DISPIMG 单元格位置
                    dispimg_positions = []  # [(df_row_idx, col_idx, guid)]
                    try:
                        df_raw = pd.read_excel(source_path, header=None, dtype=object)
                        df_row_idx = 0
                        for r in range(header_row + 1, len(df_raw)):
                            row_vals = df_raw.iloc[r].tolist()
                            is_empty_row = all(pd.isna(v) or str(v).strip() == '' for v in row_vals)
                            has_dispimg = False
                            for c in range(len(df_raw.columns)):
                                val = df_raw.iloc[r, c]
                                if pd.notna(val) and 'DISPIMG' in str(val):
                                    guid_match = re.search(r'ID_([A-F0-9]+)', str(val))
                                    if guid_match:
                                        guid = 'ID_' + guid_match.group(1)
                                        dispimg_positions.append((df_row_idx, c, guid))
                                        has_dispimg = True
                            if not is_empty_row or has_dispimg:
                                df_row_idx += 1
                    except Exception:
                        pass
                    
                    # 如果没有 guid_to_rid 映射（cellImages.xml损坏），按行顺序匹配
                    if not guid_to_rid and dispimg_positions:
                        sorted_rids = sorted(ci_rid_to_file.keys(),
                            key=lambda x: int(x[3:]) if x[3:].isdigit() else 0)
                        for i, (row_idx, col_idx, guid) in enumerate(dispimg_positions):
                            if i < len(sorted_rids):
                                guid_to_rid[guid] = sorted_rids[i]
                    
                    # 提取图片
                    for row_idx, col_idx, guid in dispimg_positions:
                        if row_idx < 0:
                            continue
                        rid = guid_to_rid.get(guid, '')
                        image_file = ci_rid_to_file.get(rid, '')
                        if not image_file:
                            continue
                        full_path = 'xl/' + image_file if not image_file.startswith('xl/') else image_file
                        if full_path not in all_names:
                            continue
                        try:
                            images_map[(row_idx, col_idx)] = z.read(full_path)
                        except Exception:
                            continue
            
            # ============================================================
            # 方式2: drawings 格式 (浮动图片/锚点) — 使用 lxml 解析
            # ============================================================
            # 收集所有 drawing XML 文件（按文件名排序保证稳定顺序）
            drawing_xmls = sorted([
                n for n in all_names
                if n.startswith('xl/drawings/drawing')
                and n.endswith('.xml')
                and '/_rels/' not in n
            ])
            
            if drawing_xmls and _HAS_LXML:
                # Drawing XML 的命名空间
                NS = {
                    'xdr': 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing',
                    'a':   'http://schemas.openxmlformats.org/drawingml/2006/main',
                    'r':   'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
                }
                R_EMBED = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}embed'
                
                for drawing_xml_path in drawing_xmls:
                    # ── 读取 drawing 的关系文件 ──
                    rels_path = _parse_drawing_rel_path(drawing_xml_path)
                    if rels_path not in all_names:
                        continue
                    
                    rid_to_target = {}
                    try:
                        rels_xml_bytes = z.read(rels_path)
                        rels_root = _lxml_etree.fromstring(rels_xml_bytes)
                        for rel in rels_root:
                            rid = rel.get('Id')
                            target = rel.get('Target')
                            if rid and target:
                                rid_to_target[rid] = target
                    except Exception:
                        continue
                    
                    if not rid_to_target:
                        continue
                    
                    # ── 解析 drawing XML ──
                    try:
                        drawing_xml_bytes = z.read(drawing_xml_path)
                        drawing_root = _lxml_etree.fromstring(drawing_xml_bytes)
                    except Exception:
                        continue
                    
                    # 遍历所有 twoCellAnchor 和 oneCellAnchor
                    for anchor in drawing_root.findall('.//xdr:twoCellAnchor', NS) + \
                                  drawing_root.findall('.//xdr:oneCellAnchor', NS):
                        # ── 提取单元格位置 ──
                        from_el = anchor.find('.//xdr:from', NS)
                        if from_el is None:
                            continue
                        col_el = from_el.find('xdr:col', NS)
                        row_el = from_el.find('xdr:row', NS)
                        if col_el is None or row_el is None:
                            continue
                        
                        try:
                            col = int(col_el.text)
                            raw_row = int(row_el.text)
                        except (ValueError, TypeError):
                            continue
                        
                        # ── 查找图片引用（blip）──
                        # 可能在 <xdr:pic> 或 <xdr:sp>（形状填充）中
                        blip = anchor.find('.//a:blip', NS)
                        if blip is None:
                            continue
                        
                        embed_id = blip.get(R_EMBED)
                        if embed_id is None or embed_id not in rid_to_target:
                            continue
                        
                        # ── 解析媒体文件路径 ──
                        media_target = rid_to_target[embed_id]
                        if media_target.startswith('../'):
                            # ../media/image1.png → xl/media/image1.png
                            media_path = 'xl/' + media_target[3:]
                        else:
                            media_path = media_target
                        
                        if media_path not in all_names:
                            continue
                        
                        # ── 提取图片尺寸（用于后续缩放）──
                        px_w, px_h = 120, 120  # 默认尺寸
                        sp_pr = anchor.find('.//xdr:spPr', NS)
                        if sp_pr is None:
                            sp_pr = anchor.find('.//a:spPr', NS)
                        if sp_pr is not None:
                            xfrm = sp_pr.find('.//a:xfrm', NS)
                            if xfrm is not None:
                                ext = xfrm.find('a:ext', NS)
                                if ext is not None:
                                    try:
                                        ext_x = int(float(ext.get('cx', 0)))
                                        ext_y = int(float(ext.get('cy', 0)))
                                        # EMU → 像素 (1 EMU = 1/914400 inch, 96 DPI)
                                        if ext_x > 0:
                                            px_w = max(ext_x * 96 // 914400, 50)
                                        if ext_y > 0:
                                            px_h = max(ext_y * 96 // 914400, 50)
                                    except (ValueError, TypeError):
                                        pass
                        
                        # ── 将 raw_row 映射到 df_row_idx ──
                        df_row_idx = raw_to_df.get(raw_row)
                        if df_row_idx is None:
                            if raw_row > header_row:
                                df_row_idx = raw_row - header_row - 1
                            else:
                                continue
                        
                        # ── 读取图片数据 ──
                        try:
                            img_data = z.read(media_path)
                            if len(img_data) <= 50:  # 过滤无效图片
                                continue
                        except Exception:
                            continue
                        
                        # 避免覆盖 cellImages 已经提取的图片；保留尺寸信息
                        key = (df_row_idx, col)
                        if key not in images_map:
                            images_map[key] = img_data
            
            # ============================================================
            # 方式2 降级：无 lxml 时使用正则表达式（兼容性后备）
            # ============================================================
            elif drawing_xmls and not _HAS_LXML:
                for drawing_xml_path in drawing_xmls:
                    rels_path = _parse_drawing_rel_path(drawing_xml_path)
                    if rels_path not in all_names:
                        continue
                    
                    dr_rid_to_file = {}
                    try:
                        rels_xml = z.read(rels_path).decode('utf-8')
                        for m in re.finditer(r'Id="(rId\d+)"[^>]*Target="([^"]+)"', rels_xml):
                            target = m.group(2)
                            if target.startswith('../media/'):
                                target = 'xl/media/' + target.split('/')[-1]
                            elif not target.startswith('xl/'):
                                target = 'xl/drawings/' + target
                            dr_rid_to_file[m.group(1)] = target
                    except Exception:
                        continue
                    
                    if not dr_rid_to_file:
                        continue
                    
                    try:
                        dr_xml = z.read(drawing_xml_path).decode('utf-8')
                        anchor_pattern = re.compile(
                            r'<xdr:(?:twoCellAnchor|oneCellAnchor)[^>]*>'
                            r'.*?<xdr:from>'
                            r'.*?<xdr:col>(\d+)</xdr:col>'
                            r'.*?<xdr:row>(\d+)</xdr:row>'
                            r'.*?<a:blip[^>]*r:embed="(rId\d+)"',
                            re.DOTALL
                        )
                        for m in anchor_pattern.finditer(dr_xml):
                            col = int(m.group(1))
                            raw_row = int(m.group(2))
                            rid = m.group(3)
                            
                            df_row_idx = raw_to_df.get(raw_row)
                            if df_row_idx is None:
                                if raw_row > header_row:
                                    df_row_idx = raw_row - header_row - 1
                                else:
                                    continue
                            
                            image_file = dr_rid_to_file.get(rid, '')
                            if not image_file or image_file not in all_names:
                                continue
                            
                            key = (df_row_idx, col)
                            if key not in images_map:
                                try:
                                    images_map[key] = z.read(image_file)
                                except Exception:
                                    continue
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
    source_df, source_headers, source_header_row = read_source_file(source_file)
    
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
        
        # 读取参考模板数据用于AI列采样
        ref_df = None
        try:
            ref_df = pd.read_excel(reference_file, header=0, dtype=object)
            ref_df = ref_df.dropna(how='all').reset_index(drop=True)
        except Exception:
            pass
        
        # 执行匹配（含逐列数据采样对比）
        formula_headers = get_formula_headers(template)
        mappings = match_headers(
            source_headers=source_headers,
            target_headers=target_headers,
            use_ai=use_ai,
            source_df=source_df,
            reference_df=ref_df,
            reference_headers=target_headers,
            formula_columns=formula_headers,
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
    
    # 动态检测毛利率列（根据参考模板表头，含"毛利率"的列）
    margin_columns = []
    for idx, h in enumerate(target_headers):
        if '毛利率' in normalize_header(h):
            margin_columns.append(get_column_letter(idx + 1))
    
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
            
            # 毛利率列：强制写入统一配置值
            if col_letter in margin_columns:
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
    # 提取源文件中的嵌入图片（传入 header_row 确保行索引与 DataFrame 对齐）
    images_map = extract_images_from_source(source_file, header_row=source_header_row)
    if images_map and verbose:
        print(f"  🖼️ 检测到 {len(images_map)} 张嵌入图片，正在复制...")
    
    # 查找图片列：先在 column_mapping 中找，找不到则直接根据列名在源表和目标表中查找
    target_img_col = None
    source_img_col = None
    
    # 方式A：从 column_mapping 中查找（AI/规则匹配结果）
    for src_col_name, tgt_idx in column_mapping.items():
        if '图片' in normalize_header(src_col_name):
            for i, h in enumerate(source_headers):
                if normalize_header(h) == normalize_header(src_col_name):
                    source_img_col = i
                    break
            target_img_col = tgt_idx
            break
    
    # 方式B：如果 column_mapping 中没有，直接在源表和目标表头中按列名查找
    if source_img_col is None:
        for i, h in enumerate(source_headers):
            if '图片' in normalize_header(h):
                source_img_col = i
                break
    if target_img_col is None and source_img_col is not None:
        for i, h in enumerate(target_headers):
            if '图片' in normalize_header(h):
                target_img_col = i
                break
    
    if images_map and source_img_col is not None and target_img_col is not None:
        inserted = 0
        from openpyxl.drawing.spreadsheet_drawing import AnchorMarker, OneCellAnchor
        from openpyxl.drawing.xdr import XDRPositiveSize2D
        
        # 列宽 EMU
        target_col_letter = get_column_letter(target_img_col + 1)
        col_width_chars = template['column_widths'].get(target_col_letter, None)
        if col_width_chars:
            col_width_emu = int(col_width_chars * 7 * 914400 / 96)
        else:
            col_width_emu = 1143000  # 默认 120px in EMU
        
        # 行高与边距（从 config 读取）
        ROW_HEIGHT_PT = IMAGE_ROW_HEIGHT_PT
        MARGIN_PT = IMAGE_MARGIN_PT
        MAX_IMG_H_EMU = int((ROW_HEIGHT_PT - MARGIN_PT * 2) * 12700)  # 图片最大高度 EMU
        ROW_HEIGHT_EMU = int(ROW_HEIGHT_PT * 12700)
        
        # 统一设置所有数据行高度为 60pt
        for r in range(2, len(source_df) + 2):
            ws.row_dimensions[r].height = ROW_HEIGHT_PT
        
        # 计算每张图片缩放后尺寸（高度限制在 MAX_IMG_H_EMU 内，宽度等比缩放）
        img_sizes = {}  # (src_row, src_col) → (emu_w, emu_h, colOff)
        for (src_row, src_col), img_data in images_map.items():
            if src_col == source_img_col and src_row < len(source_df):
                try:
                    test_img = OpenpyxlImage(io.BytesIO(img_data))
                    orig_w = max(test_img.width, 1)
                    orig_h = max(test_img.height, 1)
                    orig_h_emu = int(orig_h * 914400 / 96)
                    orig_w_emu = int(orig_w * 914400 / 96)
                    
                    # 按高度缩放
                    if orig_h_emu > MAX_IMG_H_EMU:
                        ratio = MAX_IMG_H_EMU / orig_h_emu
                        scaled_h_emu = MAX_IMG_H_EMU
                        scaled_w_emu = int(orig_w_emu * ratio)
                    else:
                        scaled_h_emu = orig_h_emu
                        scaled_w_emu = orig_w_emu
                    
                    # 水平居中：计算 colOff
                    if scaled_w_emu < col_width_emu:
                        col_off = (col_width_emu - scaled_w_emu) // 2
                    else:
                        col_off = 0
                    
                    img_sizes[(src_row, src_col)] = (scaled_w_emu, scaled_h_emu, col_off)
                except Exception:
                    pass
        
        # 插入图片（居中放置）
        for (src_row, src_col), img_data in images_map.items():
            if src_col == source_img_col and src_row < len(source_df):
                size = img_sizes.get((src_row, src_col))
                if size is None:
                    continue
                emu_w, emu_h, col_off = size
                try:
                    img_stream = io.BytesIO(img_data)
                    img = OpenpyxlImage(img_stream)
                    
                    # 垂直居中
                    row_off = (ROW_HEIGHT_EMU - emu_h) // 2
                    
                    target_row = src_row + 2
                    from_marker = AnchorMarker(
                        col=target_img_col, colOff=col_off,
                        row=target_row - 1, rowOff=row_off
                    )
                    anchor = OneCellAnchor(
                        _from=from_marker,
                        ext=XDRPositiveSize2D(cx=emu_w, cy=emu_h)
                    )
                    ws.add_image(img, anchor)
                    inserted += 1
                except Exception:
                    pass
        if verbose:
            print(f"  ✅ 成功插入 {inserted} 张图片")
    elif images_map and source_img_col is not None and target_img_col is None:
        if verbose:
            print(f"  ⚠️ 检测到 {len(images_map)} 张图片，但目标模板中没有找到'图片'列，图片未插入")
    
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


if __name__ == "__main__":
    # 测试：转换 表/ 目录下第一个 .xlsx 文件
    import glob
    test_files = glob.glob(os.path.join(TABLE_DIR, "*.xlsx")) + glob.glob(os.path.join(TABLE_DIR, "*.xls"))
    if test_files:
        convert_table(
            source_file=test_files[0],
            reference_file=REFERENCE_FILE,
            use_ai=True,
        )
    else:
        print("未找到测试文件，请将表格放入 表/ 目录")
