"""
表格转换工具 - 主程序入口
将客户发来的原始表格自动转换为公司内部参考表格格式

功能：
1. 读取客户原始表格和公司参考模板
2. 使用 DeepSeek AI 智能匹配列名
3. 自动转换并保留公式列
4. 批量处理多个文件

用法：
    python main.py                    # 批量转换所有配置的源文件
    python main.py <源文件路径>        # 转换单个文件
    python main.py --no-ai            # 不使用AI，仅用规则匹配
"""

import sys
import os
import argparse

# 添加当前目录到路径
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from config import SOURCE_FILES, REFERENCE_FILE, OUTPUT_DIR
from table_converter import convert_table, batch_convert


def main():
    parser = argparse.ArgumentParser(
        description="表格转换工具 - 将客户原始表格转换为公司内部格式",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  python main.py                                    # 批量转换所有配置的源文件
  python main.py "表/2026示例大客户代发价格.xlsx"    # 转换单个文件
  python main.py --no-ai                            # 不使用AI，仅用规则匹配
  python main.py --ref "表/参考.xlsx"                 # 指定参考模板
        """
    )
    
    parser.add_argument(
        "source",
        nargs="?",
        help="原始表格文件路径（不指定则批量转换配置中的所有文件）"
    )
    
    parser.add_argument(
        "--ref", "-r",
        default=REFERENCE_FILE,
        help=f"参考表格（模板）路径（默认: {REFERENCE_FILE}）"
    )
    
    parser.add_argument(
        "--no-ai",
        action="store_true",
        help="不使用AI匹配，仅使用硬编码规则"
    )
    
    parser.add_argument(
        "--output", "-o",
        help="输出文件路径（仅单文件转换时有效）"
    )
    
    parser.add_argument(
        "--list",
        action="store_true",
        help="列出配置中的所有源文件"
    )
    
    args = parser.parse_args()
    
    # 列出文件
    if args.list:
        print("\n📋 配置的源文件列表:")
        for f in SOURCE_FILES:
            exists = "✅" if os.path.exists(f) else "❌"
            print(f"  {exists} {f}")
        print(f"\n📄 参考模板: {REFERENCE_FILE}")
        print(f"  {'✅' if os.path.exists(REFERENCE_FILE) else '❌'} {REFERENCE_FILE}")
        return
    
    # 检查参考模板是否存在
    if not os.path.exists(args.ref):
        print(f"❌ 参考模板不存在: {args.ref}")
        sys.exit(1)
    
    use_ai = not args.no_ai
    
    if args.source:
        # 单文件转换
        if not os.path.exists(args.source):
            print(f"❌ 源文件不存在: {args.source}")
            sys.exit(1)
        
        print(f"\n🔧 单文件转换模式")
        print(f"  源文件: {args.source}")
        print(f"  参考模板: {args.ref}")
        print(f"  AI匹配: {'开启' if use_ai else '关闭'}")
        
        output = convert_table(
            source_file=args.source,
            reference_file=args.ref,
            output_file=args.output,
            use_ai=use_ai,
            verbose=True,
        )
        print(f"\n✅ 转换完成!")
        print(f"📁 输出文件: {output}")
    else:
        # 批量转换
        # 检查源文件
        existing_files = [f for f in SOURCE_FILES if os.path.exists(f)]
        missing_files = [f for f in SOURCE_FILES if not os.path.exists(f)]
        
        if missing_files:
            print(f"⚠️ 以下文件不存在，将跳过:")
            for f in missing_files:
                print(f"  ❌ {f}")
        
        if not existing_files:
            print("❌ 没有可用的源文件")
            sys.exit(1)
        
        print(f"\n🔧 批量转换模式")
        print(f"  源文件数: {len(existing_files)}")
        print(f"  参考模板: {args.ref}")
        print(f"  AI匹配: {'开启' if use_ai else '关闭'}")
        
        output_files = batch_convert(
            source_files=existing_files,
            reference_file=args.ref,
            use_ai=use_ai,
        )
        
        print(f"\n✅ 全部完成!")
        print(f"📁 输出目录: {OUTPUT_DIR}")
        for f in output_files:
            print(f"  📄 {os.path.basename(f)}")


if __name__ == "__main__":
    main()
