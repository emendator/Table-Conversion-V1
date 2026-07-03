"""
表格转换工具 - Web 前端后端服务
基于 Flask 提供 REST API 和前端页面
"""

import os
import sys
import uuid
import json
import tempfile
import shutil
from datetime import datetime
from werkzeug.utils import secure_filename

from flask import (
    Flask, render_template, request, jsonify, 
    send_file, session, url_for
)

# 添加当前目录到路径
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from config import (
    BASE_DIR, OUTPUT_DIR, DEEPSEEK_API_KEY,
    SPECIAL_MAPPINGS, SKIP_TARGET_COLUMNS,
    MARGIN_RATE, MARGIN_COLUMNS,
)
from table_converter import (
    read_source_file, read_reference_template,
    normalize_header, convert_table,
    extract_images_from_source,
)
from deepseek_matcher import match_headers

# ============================================================
# Flask 应用初始化
# ============================================================
app = Flask(__name__)
app.secret_key = os.urandom(24).hex()
app.config['MAX_CONTENT_LENGTH'] = 300 * 1024 * 1024  # 300MB 上传限制（表格含图片较大）

# 上传和输出目录
UPLOAD_DIR = os.path.join(BASE_DIR, 'uploads')
os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(OUTPUT_DIR, exist_ok=True)

# 会话存储（简化版，生产环境应用 Redis）
sessions = {}


def get_session():
    """获取或创建会话"""
    sid = session.get('sid')
    if not sid or sid not in sessions:
        sid = uuid.uuid4().hex
        session['sid'] = sid
        sessions[sid] = {
            'source_path': None,
            'source_headers': [],
            'reference_path': None,
            'reference_headers': [],
            'mappings': [],
            'output_path': None,
        }
    return sessions[sid]


# ============================================================
# 错误处理 - 返回 JSON 而非 HTML
# ============================================================
@app.errorhandler(413)
def too_large(e):
    return jsonify({
        'success': False,
        'error': '文件过大，超过服务器上传限制(300MB)。请压缩表格中的图片后重试。'
    }), 413


@app.errorhandler(500)
def server_error(e):
    return jsonify({
        'success': False,
        'error': f'服务器内部错误: {str(e)}'
    }), 500


# ============================================================
# 页面路由
# ============================================================
@app.route('/')
def index():
    """主页面"""
    return render_template('index.html')


# ============================================================
# API 路由 - 文件上传
# ============================================================
@app.route('/api/upload/source', methods=['POST'])
def upload_source():
    """上传原始表格文件"""
    if 'file' not in request.files:
        return jsonify({'success': False, 'error': '未选择文件'})
    
    file = request.files['file']
    if file.filename == '':
        return jsonify({'success': False, 'error': '文件名为空'})
    
    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in ('.xlsx', '.xls'):
        return jsonify({'success': False, 'error': '仅支持 .xlsx / .xls 格式'})
    
    # 保存文件
    filename = secure_filename(f"source_{uuid.uuid4().hex[:8]}{ext}")
    filepath = os.path.join(UPLOAD_DIR, filename)
    file.save(filepath)
    
    # 读取并解析
    try:
        df, headers = read_source_file(filepath)
        # 取前5行预览数据
        preview = df.head(5).fillna('').to_dict(orient='records')
        # 转换数据类型以便JSON序列化
        for row in preview:
            for k, v in row.items():
                if isinstance(v, float):
                    row[k] = round(v, 4)
        
        data = get_session()
        data['source_path'] = filepath
        data['source_headers'] = headers
        data['source_name'] = os.path.splitext(file.filename)[0]
        data['source_rows'] = len(df)
        data['source_preview'] = preview
        
        return jsonify({
            'success': True,
            'filename': file.filename,
            'headers': headers,
            'rowCount': len(df),
            'preview': preview,
        })
    except Exception as e:
        return jsonify({'success': False, 'error': f'文件解析失败: {str(e)}'})


@app.route('/api/upload/reference', methods=['POST'])
def upload_reference():
    """上传参考模板文件"""
    if 'file' not in request.files:
        return jsonify({'success': False, 'error': '未选择文件'})
    
    file = request.files['file']
    if file.filename == '':
        return jsonify({'success': False, 'error': '文件名为空'})
    
    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in ('.xlsx', '.xls'):
        return jsonify({'success': False, 'error': '仅支持 .xlsx / .xls 格式'})
    
    filename = secure_filename(f"ref_{uuid.uuid4().hex[:8]}{ext}")
    filepath = os.path.join(UPLOAD_DIR, filename)
    file.save(filepath)
    
    try:
        template = read_reference_template(filepath)
        
        data = get_session()
        data['reference_path'] = filepath
        data['reference_headers'] = template['headers']
        data['formula_count'] = len(template['formula_info'])
        data['fixed_value_count'] = len(template['fixed_values'])
        data['formula_info'] = {
            k: v for k, v in template['formula_info'].items()
        }
        
        return jsonify({
            'success': True,
            'filename': file.filename,
            'headers': template['headers'],
            'formulaColumns': list(template['formula_info'].keys()),
            'formulaCount': len(template['formula_info']),
        })
    except Exception as e:
        return jsonify({'success': False, 'error': f'模板解析失败: {str(e)}'})


# ============================================================
# API 路由 - AI 列匹配
# ============================================================
@app.route('/api/match', methods=['POST'])
def api_match():
    """执行AI列名匹配，返回预览结果"""
    data = get_session()
    
    if not data['source_path']:
        return jsonify({'success': False, 'error': '请先上传原始表格'})
    if not data['reference_path']:
        return jsonify({'success': False, 'error': '请先上传参考模板'})
    
    use_ai = request.json.get('useAI', True) if request.json else True
    
    try:
        # 重新读取以确保数据最新
        df, source_headers = read_source_file(data['source_path'])
        template = read_reference_template(data['reference_path'])
        target_headers = template['headers']
        
        # 准备示例数据
        sample_rows = df.head(3).fillna('').to_string(index=False)
        
        # 执行匹配
        mappings = match_headers(
            source_headers=source_headers,
            target_headers=target_headers,
            sample_data=sample_rows,
            use_ai=use_ai,
        )
        
        # 保存映射
        data['mappings'] = mappings
        data['source_headers'] = source_headers
        data['reference_headers'] = target_headers
        
        # 构建可编辑的映射列表
        editable_mappings = []
        mapped_sources = set()
        for m in mappings:
            editable_mappings.append({
                'source': m['source_column'],
                'target': m['target_column'],
                'confidence': m.get('confidence', 'medium'),
                'reason': m.get('reason', ''),
            })
            mapped_sources.add(m['source_column'])
        
        # 未映射的源列
        unmapped = [h for h in source_headers if h not in mapped_sources]
        
        return jsonify({
            'success': True,
            'mappings': editable_mappings,
            'unmappedSources': unmapped,
            'targetOptions': target_headers,
            'sourceHeaders': source_headers,
        })
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'success': False, 'error': f'匹配失败: {str(e)}'})


# ============================================================
# API 路由 - 执行转换
# ============================================================
@app.route('/api/convert', methods=['POST'])
def api_convert():
    """执行表格转换"""
    data = get_session()
    
    if not data['source_path']:
        return jsonify({'success': False, 'error': '请先上传原始表格'})
    if not data['reference_path']:
        return jsonify({'success': False, 'error': '请先上传参考模板'})
    
    # 获取用户可能调整过的映射
    user_mappings = None
    if request.json and 'mappings' in request.json:
        user_mappings = request.json['mappings']
    
    try:
        # 如果用户提供了手动映射，暂时替换 AI 映射
        if user_mappings:
            # 构建 column_mapping 字典供转换器使用
            # 这里我们修改 session 中的 mappings
            data['mappings'] = [
                {
                    'source_column': m['source'],
                    'target_column': m['target'],
                    'confidence': 'manual',
                    'reason': '用户手动指定',
                }
                for m in user_mappings if m.get('target')
            ]
        
        output_filename = f"{data.get('source_name', 'output')}_转换结果.xlsx"
        output_path = os.path.join(OUTPUT_DIR, output_filename)
        
        # 调用转换函数（使用已保存的 mappings）
        result_path = _do_convert(
            source_path=data['source_path'],
            reference_path=data['reference_path'],
            output_path=output_path,
            mappings=data.get('mappings', []),
            source_name=data.get('source_name', ''),
        )
        
        data['output_path'] = result_path
        data['output_name'] = os.path.basename(result_path)
        
        # 生成对比预览数据
        comparison = _build_comparison(data['source_path'], result_path)
        
        return jsonify({
            'success': True,
            'outputName': os.path.basename(result_path),
            'downloadUrl': '/api/download',
            'comparison': comparison,
        })
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'success': False, 'error': f'转换失败: {str(e)}'})


def _build_comparison(source_path, output_path):
    """构建源表与结果表的对比预览数据（全列，最多20行）"""
    try:
        import openpyxl
        
        # 读取源表
        src_df, src_headers = read_source_file(source_path)
        src_preview = []
        max_rows = min(20, len(src_df))
        for i in range(max_rows):
            row = {}
            for h in src_headers:
                val = src_df.iloc[i][h] if h in src_df.columns else ''
                if hasattr(val, 'item'):
                    val = val.item()
                if val is not None and str(val) != 'nan':
                    row[str(h)] = str(val)
                else:
                    row[str(h)] = ''
            src_preview.append(row)
        
        # 读取输出表
        wb = openpyxl.load_workbook(output_path)
        ws = wb.active
        out_headers = []
        for c in range(1, ws.max_column + 1):
            h = ws.cell(row=1, column=c).value
            out_headers.append(str(h) if h else '')
        
        out_preview = []
        out_max_rows = min(20, ws.max_row - 1)  # minus header row
        for r in range(2, out_max_rows + 2):
            row = {}
            for c in range(1, ws.max_column + 1):
                h = out_headers[c - 1] if c - 1 < len(out_headers) else f'Col{c}'
                val = ws.cell(row=r, column=c).value
                row[str(h)] = str(val) if val is not None else ''
            out_preview.append(row)
        wb.close()
        
        return {
            'sourceHeaders': src_headers,
            'sourcePreview': src_preview,
            'sourceRowCount': len(src_df),
            'outputHeaders': out_headers,
            'outputPreview': out_preview,
            'outputRowCount': ws.max_row - 1,
        }
    except Exception as e:
        return {'error': str(e)}


def _do_convert(source_path, reference_path, output_path, mappings, source_name):
    """执行实际的转换，使用已保存的映射"""
    import pandas as pd
    import openpyxl
    from openpyxl.utils import get_column_letter
    from copy import copy
    import re
    
    # 读取数据
    df, source_headers = read_source_file(source_path)
    template = read_reference_template(reference_path)
    target_headers = template['headers']
    formula_info = template['formula_info']
    fixed_values = template['fixed_values']
    formula_deps = template['formula_dependencies']
    
    num_target_cols = template['max_column']
    
    # 构建列映射：源列名 → 目标列索引(0-based)
    column_mapping = {}
    
    # 检查是否格式相同
    same_format = (
        len(source_headers) == len(target_headers) and
        sum(1 for sh in source_headers if any(
            normalize_header(sh) == normalize_header(th) for th in target_headers
        )) >= len(source_headers) * 0.7
    )
    
    if same_format:
        for i, sh in enumerate(source_headers):
            if i < len(target_headers):
                column_mapping[sh] = i
    else:
        for m in mappings:
            src_col = m['source_column']
            tgt_col = m['target_column']
            
            src_idx = None
            for i, h in enumerate(source_headers):
                if normalize_header(h) == normalize_header(src_col):
                    src_idx = i
                    break
            
            tgt_idx = None
            tgt_clean = normalize_header(tgt_col)
            for idx, h in enumerate(target_headers):
                if normalize_header(h) == tgt_clean:
                    tgt_idx = idx
                    break
            if tgt_idx is None:
                for idx, h in enumerate(target_headers):
                    h_clean = normalize_header(h)
                    if tgt_clean in h_clean or h_clean in tgt_clean:
                        tgt_idx = idx
                        break
            
            if src_idx is not None and tgt_idx is not None:
                column_mapping[src_col] = tgt_idx
    
    # 创建输出工作簿
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Sheet1"
    
    # 写入表头
    for col_idx in range(1, num_target_cols + 1):
        cell = ws.cell(row=1, column=col_idx)
        cell.value = target_headers[col_idx - 1]
        col_letter = get_column_letter(col_idx)
        if col_letter in template['header_styles']:
            styles = template['header_styles'][col_letter]
            if styles.get('font'): cell.font = styles['font']
            if styles.get('alignment'): cell.alignment = styles['alignment']
            if styles.get('fill'): cell.fill = styles['fill']
            if styles.get('border'): cell.border = styles['border']
    
    # 写入数据
    for src_row_idx in range(len(df)):
        output_row = src_row_idx + 2
        
        # 第一遍：源数据
        for col_idx in range(1, num_target_cols + 1):
            cell = ws.cell(row=output_row, column=col_idx)
            col_letter = get_column_letter(col_idx)
            
            if col_letter in template['data_styles']:
                styles = template['data_styles'][col_letter]
                if styles.get('font'): cell.font = styles['font']
                if styles.get('alignment'): cell.alignment = styles['alignment']
                if styles.get('fill'): cell.fill = styles['fill']
                if styles.get('border'): cell.border = styles['border']
                if styles.get('number_format'): cell.number_format = styles['number_format']
            
            src_col_idx = None
            for src_col_name, tgt_idx in column_mapping.items():
                if tgt_idx == col_idx - 1:
                    for i, h in enumerate(source_headers):
                        if normalize_header(h) == normalize_header(src_col_name):
                            src_col_idx = i
                            break
                    break
            
            if src_col_idx is not None and src_col_idx < len(df.columns):
                val = df.iloc[src_row_idx, src_col_idx]
                if pd.notna(val):
                    val_str = str(val)
                    if val_str.startswith('=DISPIMG'):
                        cell.value = None
                    else:
                        try:
                            if isinstance(val, str) and val_str.strip() == '':
                                cell.value = None
                            elif isinstance(val, (int, float)):
                                if isinstance(val, float):
                                    rounded = round(val, 6)
                                    cell.value = int(rounded) if rounded == int(rounded) else rounded
                                else:
                                    cell.value = val
                            else:
                                cleaned = val_str.replace(',', '').strip()
                                if cleaned.replace('.', '').replace('-', '').isdigit():
                                    num_val = float(cleaned)
                                    rounded = round(num_val, 6)
                                    cell.value = int(rounded) if rounded == int(rounded) else rounded
                                else:
                                    cell.value = val
                        except (ValueError, TypeError):
                            cell.value = val
        
        # 第二遍：公式
        for col_idx in range(1, num_target_cols + 1):
            col_letter = get_column_letter(col_idx)
            if col_letter in formula_info:
                cell = ws.cell(row=output_row, column=col_idx)
                formula = formula_info[col_letter]
                
                def replace_row(match):
                    cl = match.group(1)
                    rn = int(match.group(2))
                    return f"{cl}{output_row}" if rn == 2 else match.group(0)
                
                adjusted = re.sub(r'([A-Z]+)(\d+)', replace_row, formula)
                cell.value = adjusted
        
        # 第三遍：写入统一毛利率配置值
        # 所有毛利率列统一使用配置的 MARGIN_RATE（默认10%），覆盖公式
        for col_idx in range(1, num_target_cols + 1):
            col_letter = get_column_letter(col_idx)
            cell = ws.cell(row=output_row, column=col_idx)
            # 毛利率列：强制写入统一配置值
            if col_letter in MARGIN_COLUMNS:
                cell.value = MARGIN_RATE
                continue
            if cell.value is not None:
                continue
            # 其他被公式引用的固定值常量
            if col_letter in formula_deps and col_letter in fixed_values:
                val = fixed_values[col_letter]
                if isinstance(val, (int, float)) and 0 < val < 1:
                    cell.value = val
    
    # 插入图片：从源文件提取嵌入图片并放入输出文件的图片列
    from openpyxl.drawing.image import Image as OpenpyxlImage
    import io as _io
    images_map = extract_images_from_source(source_path)
    target_img_col = None
    source_img_col = None
    for src_col_name, tgt_idx in column_mapping.items():
        if '图片' in normalize_header(src_col_name):
            for i, h in enumerate(source_headers):
                if normalize_header(h) == normalize_header(src_col_name):
                    source_img_col = i
                    break
            target_img_col = tgt_idx
            break
    
    if images_map and source_img_col is not None and target_img_col is not None:
        for (src_row, src_col), img_data in images_map.items():
            if src_col == source_img_col and src_row < len(df):
                try:
                    img_stream = _io.BytesIO(img_data)
                    img = OpenpyxlImage(img_stream)
                    max_width_px = 120
                    if img.width > max_width_px:
                        ratio = max_width_px / img.width
                        img.width = max_width_px
                        img.height = int(img.height * ratio)
                    target_row = src_row + 2
                    target_col_letter = get_column_letter(target_img_col + 1)
                    cell_ref = f"{target_col_letter}{target_row}"
                    ws.add_image(img, cell_ref)
                except Exception:
                    pass
    
    # 列宽
    for col_idx in range(1, num_target_cols + 1):
        col_letter = get_column_letter(col_idx)
        if col_letter in template['column_widths'] and template['column_widths'][col_letter]:
            ws.column_dimensions[col_letter].width = template['column_widths'][col_letter]
    
    wb.save(output_path)
    wb.close()
    
    return output_path


# ============================================================
# API 路由 - 文件下载
# ============================================================
@app.route('/api/download')
def download_file():
    """下载转换后的文件（从会话中获取路径，避免中文文件名URL编码问题）"""
    data = get_session()
    filepath = data.get('output_path', '')
    
    if not filepath or not os.path.exists(filepath):
        return jsonify({'success': False, 'error': '文件不存在，请先执行转换'}), 404
    
    download_name = data.get('output_name', 'result.xlsx')
    
    return send_file(
        filepath,
        as_attachment=True,
        download_name=download_name,
        mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )


# ============================================================
# API 路由 - 获取会话状态
# ============================================================
@app.route('/api/status')
def api_status():
    """获取当前会话状态"""
    data = get_session()
    return jsonify({
        'hasSource': data['source_path'] is not None,
        'sourceName': data.get('source_name', ''),
        'sourceHeaders': data['source_headers'],
        'sourceRows': data.get('source_rows', 0),
        'hasReference': data['reference_path'] is not None,
        'referenceHeaders': data['reference_headers'],
        'formulaCount': data.get('formula_count', 0),
        'hasMappings': len(data.get('mappings', [])) > 0,
        'mappingCount': len(data.get('mappings', [])),
        'hasOutput': data['output_path'] is not None,
        'outputName': data.get('output_name', ''),
    })


@app.route('/api/reset', methods=['POST'])
def api_reset():
    """重置会话"""
    sid = session.get('sid')
    if sid in sessions:
        # 清理上传文件
        data = sessions[sid]
        for key in ('source_path', 'reference_path'):
            if data.get(key) and os.path.exists(data[key]):
                try:
                    os.remove(data[key])
                except:
                    pass
        del sessions[sid]
    
    session.pop('sid', None)
    return jsonify({'success': True})


# ============================================================
# 启动入口
# ============================================================
if __name__ == '__main__':
    print("\n" + "=" * 60)
    print("  📊 表格转换工具 - Web 界面")
    print("=" * 60)
    print(f"  🌐 访问地址: http://127.0.0.1:5000")
    print(f"  📂 上传目录: {UPLOAD_DIR}")
    print(f"  📁 输出目录: {OUTPUT_DIR}")
    print("=" * 60 + "\n")
    
    app.run(debug=False, host='0.0.0.0', port=5000)
