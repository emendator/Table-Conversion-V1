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

try:
    from lxml import etree as _lxml_etree
    _HAS_LXML = True
except ImportError:
    _HAS_LXML = False

from config import (
    IMAGE_ROW_HEIGHT_PT,
    IMAGE_MARGIN_PT,
)


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


def dedupe_headers(headers: list) -> list:
    """
    将重复列名按其在表格中的先后顺序编号区分。

    例如：["金额", "金额", "金额"] → ["金额", "金额(2)", "金额(3)"]

    规则：
    - 第一个出现的列名保持原名
    - 后续重复列名追加编号 "(n)"（n 从 2 开始）
    - 若编号后的名字恰好与已有列名冲突（如用户原本就有 "金额(2)"），
      则继续递增编号，保证最终列名唯一
    """
    counts = {}
    used = set()
    result = []
    for h in headers:
        if h not in used:
            counts[h] = 1
            used.add(h)
            result.append(h)
        else:
            counts[h] += 1
            n = counts[h]
            candidate = f"{h}({n})"
            # 若候选名已被占用，继续递增
            while candidate in used:
                n += 1
                candidate = f"{h}({n})"
            used.add(candidate)
            result.append(candidate)
    return result


def _scan_formula_cells(ws, header_row_idx: int, max_rows: int = 8) -> dict:
    """
    扫描工作表中表头之后若干行的单元格，识别公式列。

    准确识别方式：只要某列在表头之后的任意一行中出现以 "=" 开头的公式，
    就认定该列为公式列（公式可能只出现在部分行）。

    Args:
        ws: openpyxl worksheet
        header_row_idx: 表头行号（1-based）
        max_rows: 扫描的最大数据行数

    Returns:
        {col_letter: formula_string}  每个公式列取第一个发现的公式
    """
    formula_info = {}
    start_row = header_row_idx + 1
    end_row = min(start_row + max_rows, ws.max_row + 1)
    for row_idx in range(start_row, end_row):
        for col_idx in range(1, ws.max_column + 1):
            cell = ws.cell(row=row_idx, column=col_idx)
            value = cell.value
            if value is not None and isinstance(value, str) and value.strip().startswith('='):
                col_letter = get_column_letter(col_idx)
                if col_letter not in formula_info:
                    formula_info[col_letter] = value.strip()
    return formula_info


def detect_source_formulas(file_path: str, header_row: int = 0) -> dict:
    """
    识别原始表格中的公式列（用 openpyxl 读取以保留公式）。

    Args:
        file_path: 原始表格文件路径
        header_row: 表头行号（0-based，与 read_source_file 返回一致）

    Returns:
        {col_letter: formula_string}  源表公式列：列字母 → 公式
    """
    try:
        wb = openpyxl.load_workbook(file_path, data_only=False)
        ws = wb.active
        header_row_idx = header_row + 1  # 0-based → 1-based
        formula_info = _scan_formula_cells(ws, header_row_idx)
        wb.close()
        return formula_info
    except Exception:
        return {}


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
    # 相同列名按先后顺序编号区分：金额, 金额(2), 金额(3)...
    # raw_headers 保留原始表头（写输出文件时用，不编号）
    raw_headers = list(headers)
    headers = dedupe_headers(headers)
    
    # 扫描表头之后的若干行，准确识别公式列（公式可能只出现在部分行）
    formula_info = _scan_formula_cells(ws, header_row_idx)   # 公式列: col_letter → formula_string

    # 数据行号：表头下一行（用于读取数据行样式）
    data_row_idx = header_row_idx + 1
    
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
        'raw_headers': raw_headers,   # 原始表头（未编号，用于输出文件）
        'header_row_idx': header_row_idx,
        'formula_info': formula_info,
        'column_widths': column_widths,
        'header_styles': header_styles,
        'data_styles': data_styles,
        'max_column': ws.max_column,
    }


def read_source_file(file_path: str):
    """
    读取原始表格文件，自动处理表头行

    相同列名按先后顺序编号区分：金额, 金额(2), 金额(3)...
    
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
    
    # 从原始数据行读取真实列名（pandas 会自动给重复列加 .1 后缀，需还原）
    raw_headers = []
    for v in df_raw.iloc[header_row].tolist():
        raw_headers.append(normalize_header(str(v) if v is not None and not pd.isna(v) else ""))
    # 相同列名按先后顺序编号区分：金额, 金额(2), 金额(3)...
    headers = dedupe_headers(raw_headers)

    # 使用找到的表头行重新读取
    df = pd.read_excel(file_path, header=header_row, dtype=object)
    
    # 用去重编号后的列名覆盖（pandas 的 .1 后缀列名与之可能不一致）
    df.columns = headers[:df.shape[1]]
    
    # 删除全空行
    df = df.dropna(how='all')
    
    # 重置索引
    df = df.reset_index(drop=True)
    
    return df, headers, header_row


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


def _extract_richdata_images(z, all_names, header_row, raw_to_df) -> dict:
    """从 Excel richData（富数据）机制中提取嵌入图片。

    Office 365「单元格内图片」使用 richData 机制（xl/richData/），
    与传统 drawings（浮动图片）/ cellImages（DISPIMG）不同：
    - 单元格带 vm 属性（value metadata 索引）
    - vm → metadata.xml valueMetadata → futureMetadata → rdrichvalue.xml rv
    - rv 的 LocalImageIdentifier → richValueRel.xml 中 rel 顺序 →
      richValueRel.xml.rels → media 图片文件

    Args:
        z: 已打开的 zipfile 对象
        all_names: zip 内所有文件名集合
        header_row: 表头行号（0-based）
        raw_to_df: 原始行号 → DataFrame 行索引映射

    Returns:
        {(df_row_idx, col_idx): image_bytes}
    """
    images_map = {}
    try:
        # 1) richValueRel.xml：rel 顺序（0-based 索引 → rId）
        rvr_name = None
        for n in all_names:
            if n.lower().endswith('richvaluerel.xml') and '/_rels/' not in n:
                rvr_name = n
                break
        if not rvr_name:
            return images_map
        rvr_xml = z.read(rvr_name).decode('utf-8')
        rel_ids = re.findall(r'r:id="(rId\d+)"', rvr_xml)

        # 2) richValueRel.xml.rels：rId → media 文件
        rv_rels_name = None
        for n in all_names:
            if n.lower().endswith('richvaluerel.xml.rels'):
                rv_rels_name = n
                break
        if not rv_rels_name:
            return images_map
        rid_to_file = {}
        rels_xml = z.read(rv_rels_name).decode('utf-8')
        for m in re.finditer(r'Id="(rId\d+)"[^>]*Target="([^"]+)"', rels_xml):
            target = m.group(2).replace('\\', '/')
            if target.startswith('../'):
                target = 'xl/' + target[3:]
            elif target.startswith('/'):
                target = target.lstrip('/')
            elif not target.startswith('xl/'):
                target = 'xl/' + target
            rid_to_file[m.group(1)] = target

        # 3) metadata.xml：valueMetadata rc v + futureMetadata rvb i
        meta_xml = ''
        if 'xl/metadata.xml' in all_names:
            meta_xml = z.read('xl/metadata.xml').decode('utf-8')
        vm_match = re.search(r'<valueMetadata[^>]*>(.*?)</valueMetadata>', meta_xml, re.DOTALL)
        valmeta = re.findall(r'<rc\b[^>]*v="(\d+)"', vm_match.group(1)) if vm_match else []
        fm_match = re.search(r'<futureMetadata\b[^>]*>(.*?)</futureMetadata>', meta_xml, re.DOTALL)
        rvb = re.findall(r'rvb\s+i="(\d+)"', fm_match.group(1)) if fm_match else []
        if not valmeta or not rvb:
            return images_map

        # 4) rdrichvalue.xml：rv 的 LocalImageIdentifier（第一个 v）
        rv_ids = []
        rv_xml_name = None
        for n in all_names:
            if n.lower().endswith('rdrichvalue.xml') and '/_rels/' not in n:
                rv_xml_name = n
                break
        if not rv_xml_name:
            return images_map
        rv_xml = z.read(rv_xml_name).decode('utf-8')
        for m in re.finditer(r'<rv\b[^>]*>(.*?)</rv>', rv_xml, re.DOTALL):
            vals = re.findall(r'<v>([^<]*)</v>', m.group(1))
            if vals and vals[0].strip().isdigit():
                rv_ids.append(int(vals[0]))

        # 5) 遍历所有 sheet，找带 vm 属性的单元格
        for n in sorted(all_names):
            if not re.match(r'xl/worksheets/sheet\d+\.xml$', n):
                continue
            sheet_xml = z.read(n).decode('utf-8')
            for m in re.finditer(r'<c r="([A-Z]+\d+)"[^>]*?vm="(\d+)"', sheet_xml):
                cell_ref = m.group(1)
                vm = int(m.group(2))
                if vm >= len(valmeta):
                    continue
                fm_idx = int(valmeta[vm])
                if fm_idx >= len(rvb):
                    continue
                rv_idx = int(rvb[fm_idx])
                if rv_idx >= len(rv_ids):
                    continue
                lid = rv_ids[rv_idx]
                if lid >= len(rel_ids):
                    continue
                rid = rel_ids[lid]
                media_path = rid_to_file.get(rid, '')
                if not media_path or media_path not in all_names:
                    continue

                # 解析单元格位置 → (df_row_idx, col_idx)
                col_match = re.match(r'([A-Z]+)(\d+)', cell_ref)
                if not col_match:
                    continue
                col_letter = col_match.group(1)
                row_num = int(col_match.group(2))
                col_idx = 0
                for ch in col_letter:
                    col_idx = col_idx * 26 + (ord(ch) - 64)
                col_idx -= 1  # 0-based
                raw_row = row_num - 1  # 0-based 原始行号

                df_row_idx = raw_to_df.get(raw_row)
                if df_row_idx is None:
                    if raw_row > header_row:
                        df_row_idx = raw_row - header_row - 1
                    else:
                        continue

                try:
                    img_data = z.read(media_path)
                    if len(img_data) <= 50:
                        continue
                    key = (df_row_idx, col_idx)
                    if key not in images_map:
                        images_map[key] = img_data
                except Exception:
                    continue
    except Exception:
        pass
    return images_map


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
                            # 按 <xdr:pic>...</xdr:pic> 块解析，块内取 name 与 r:embed，
                            # 兼容属性顺序、空白、子元素顺序变化（比整文档宽松匹配更稳健）
                            for blk in re.finditer(r'<xdr:pic\b.*?</xdr:pic>', ci_xml, re.DOTALL):
                                block = blk.group(0)
                                nm = re.search(r'name="(ID_[^"]+)"', block)
                                emb = re.search(r'r:embed="(rId\d+)"', block)
                                if nm and emb:
                                    guid_to_rid[nm.group(1)] = emb.group(1)
                            # 兜底：块解析失败时退回旧的宽松匹配
                            if not guid_to_rid:
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
                        
                        # ── 解析媒体文件路径（兼容多种相对/绝对写法）──
                        media_target = rid_to_target[embed_id].replace('\\', '/')
                        if media_target.startswith('/'):
                            # /xl/media/image1.png → xl/media/image1.png
                            media_path = media_target.lstrip('/')
                        elif media_target.startswith('../'):
                            # ../media/image1.png → xl/media/image1.png
                            media_path = 'xl/' + media_target[3:]
                        elif media_target.startswith('media/'):
                            media_path = 'xl/' + media_target
                        elif not media_target.startswith('xl/'):
                            # 相对 drawings 目录的 target（如 image1.png → xl/drawings/image1.png）
                            media_path = 'xl/drawings/' + media_target
                        else:
                            media_path = media_target

                        # 仅保留常见图片格式，跳过图表/其他关系
                        if not media_path.lower().endswith(
                                ('.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tiff', '.tif',
                                 '.svg', '.emf', '.wmf', '.webp', '.avif', '.ico')):
                            continue
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
            
            # ============================================================
            # 方式3: richData 格式（Office 365「单元格内图片」富数据）
            # 图片通过 xl/richData/richValueRel.xml + rdrichvalue.xml + metadata.xml
            # 与带 vm 属性的单元格关联，区别于传统 drawings / cellImages。
            # ============================================================
            richdata_images = _extract_richdata_images(z, all_names, header_row, raw_to_df)
            for k, v in richdata_images.items():
                if k not in images_map:
                    images_map[k] = v
    
    except Exception:
        pass
    
    return images_map

