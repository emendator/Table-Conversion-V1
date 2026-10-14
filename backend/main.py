"""
表格转换工具 - 命令行入口
将客户发来的原始表格自动转换为公司内部参考表格格式

用法：
    python main.py <参考模板> <源文件1> [源文件2 ...]    批量转换
    python main.py <参考模板> <源文件> --no-ai           不使用AI匹配

说明：
    CLI 复用 Web 后端的新版转换逻辑（app._do_convert / _do_batch_convert），
    与网页端行为一致（公式处理、图片复制等）。
"""

import sys
import os
import argparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# 兼容 Windows GBK 控制台：避免 emoji 等字符导致 UnicodeEncodeError
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass
from config import OUTPUT_DIR
from table_converter import (
    read_reference_template, read_source_file, get_formula_headers,
    detect_source_formulas,
)
from deepseek_matcher import match_headers
from app import _do_convert, _do_batch_convert
import ai_config


def _auto_match(source_path: str, reference_path: str, use_ai: bool) -> list:
    """无用户映射时自动匹配列名，返回转换所需的 mappings 列表"""
    import pandas as pd

    template = read_reference_template(reference_path)
    target_headers = template["headers"]
    df, src_headers, _ = read_source_file(source_path)

    ref_df = None
    try:
        ref_df = pd.read_excel(reference_path, header=0, dtype=object)
        ref_df = ref_df.dropna(how="all").reset_index(drop=True)
    except Exception:
        pass

    mappings_raw = match_headers(
        src_headers, target_headers, use_ai=use_ai,
        source_df=df, reference_df=ref_df,
        reference_headers=target_headers,
        formula_columns=get_formula_headers(template),
    )
    return [{
        "source_column": m["source_column"],
        "target_column": m["target_column"],
        "formula_action": "default",
    } for m in mappings_raw]


def main():
    parser = argparse.ArgumentParser(
        description="表格转换工具 - 将原始表格转换为统一模板格式",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  python main.py 路径/参考模板.xlsx 路径/源表.xlsx                  单文件转换
  python main.py 路径/参考模板.xlsx 路径/源表A.xlsx 路径/源表B.xlsx   批量转换
  python main.py 路径/参考模板.xlsx 路径/源表.xlsx --no-ai          不用AI
  python main.py --set-api-key sk-xxx                         设置 DeepSeek API Key（加密存储）
        """
    )

    parser.add_argument(
        "--set-api-key",
        metavar="KEY",
        help="设置 DeepSeek API Key（加密存储到 data/ai_config.json），单独使用"
    )

    parser.add_argument(
        "reference",
        nargs="?",
        help="参考表格（模板）路径"
    )

    parser.add_argument(
        "sources",
        nargs="*",
        help="原始表格文件路径（可多个）"
    )

    parser.add_argument(
        "--no-ai",
        action="store_true",
        help="不使用AI匹配，仅用本地智能匹配引擎"
    )

    parser.add_argument(
        "--output", "-o",
        help="输出文件路径（仅单文件时有效）"
    )

    args = parser.parse_args()

    # 设置 API Key（独立模式）：加密存储并退出
    if args.set_api_key:
        if not args.set_api_key.startswith("sk-"):
            print("❌ API Key 格式不正确（应以 sk- 开头）")
            sys.exit(1)
        ai_config.save_api_key(args.set_api_key)
        print(f"✅ API Key 已加密保存: {ai_config.masked_api_key()}")
        print(f"   （存储于 {ai_config.CONFIG_FILE}，网页与命令行均可使用）")
        return

    # 检查参考模板
    if not args.reference or not os.path.exists(args.reference):
        print(f"❌ 参考模板不存在: {args.reference}")
        sys.exit(1)

    # 检查源文件
    valid_sources = [f for f in args.sources if f and os.path.exists(f)]
    missing = [f for f in args.sources if f and not os.path.exists(f)]
    if missing:
        print(f"⚠️ 以下文件不存在，将跳过:")
        for f in missing:
            print(f"  ❌ {f}")
    if not valid_sources:
        print("❌ 没有可用的源文件")
        sys.exit(1)

    use_ai = not args.no_ai

    source_count = len(valid_sources)
    print(f"\n🔧 转换模式: {'批量' if source_count > 1 else '单文件'}")
    print(f"  源文件数: {source_count}")
    print(f"  参考模板: {args.reference}")
    print(f"  AI匹配: {'开启' if use_ai else '关闭'}")

    if source_count == 1:
        src = valid_sources[0]
        src_name = os.path.splitext(os.path.basename(src))[0]
        output = args.output or os.path.join(OUTPUT_DIR, f"{src_name}_转换结果.xlsx")
        mappings = _auto_match(src, args.reference, use_ai)
        print(f"\n  🤖 自动匹配完成: {len(mappings)} 个列映射")
        result = _do_convert(
            source_path=src,
            reference_path=args.reference,
            output_path=output,
            mappings=mappings,
            source_name=src_name,
            source_formula_info=detect_source_formulas(src),
        )
        print(f"\n✅ 转换完成! → {os.path.basename(result)}")
    else:
        source_files = [
            {
                "path": f,
                "name": os.path.splitext(os.path.basename(f))[0],
                "source_formula_info": detect_source_formulas(f),
            }
            for f in valid_sources
        ]
        output = args.output or os.path.join(OUTPUT_DIR, f"批量转换结果_{source_count}个文件.xlsx")
        result = _do_batch_convert(
            source_files=source_files,
            reference_path=args.reference,
            output_path=output,
            user_mappings=None,
        )
        print(f"\n✅ 批量转换完成! → {os.path.basename(result)}")


if __name__ == "__main__":
    main()
