"""
表格转换工具 - 命令行入口
将客户发来的原始表格自动转换为公司内部参考表格格式

用法：
    python main.py <参考模板> <源文件1> [源文件2 ...]    批量转换
    python main.py <参考模板> <源文件> --no-ai           不使用AI匹配
"""

import sys
import os
import argparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from config import OUTPUT_DIR
from table_converter import convert_table


def main():
    parser = argparse.ArgumentParser(
        description="表格转换工具 - 将客户原始表格转换为公司内部格式",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  python main.py 表/参考.xlsx 表/示例.xlsx                    单文件转换
  python main.py 表/参考.xlsx 表/示例.xlsx 表/源表B.xls        批量转换
  python main.py 表/参考.xlsx 表/示例.xlsx --no-ai            不用AI
        """
    )
    
    parser.add_argument(
        "reference",
        help="参考表格（模板）路径"
    )
    
    parser.add_argument(
        "sources",
        nargs="+",
        help="原始表格文件路径（可多个）"
    )
    
    parser.add_argument(
        "--no-ai",
        action="store_true",
        help="不使用AI匹配，仅用硬编码规则"
    )
    
    parser.add_argument(
        "--output", "-o",
        help="输出文件路径（仅单文件时有效）"
    )
    
    args = parser.parse_args()
    
    # 检查参考模板
    if not os.path.exists(args.reference):
        print(f"❌ 参考模板不存在: {args.reference}")
        sys.exit(1)
    
    # 检查源文件
    valid_sources = [f for f in args.sources if os.path.exists(f)]
    missing = [f for f in args.sources if not os.path.exists(f)]
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
    
    for src in valid_sources:
        output = convert_table(
            source_file=src,
            reference_file=args.reference,
            output_file=args.output if source_count == 1 else None,
            use_ai=use_ai,
            verbose=True,
        )
        print(f"\n✅ 转换完成! → {os.path.basename(output)}")


if __name__ == "__main__":
    main()
