"""
配置文件 - 表格转换项目的全局配置

注意：表格列结构（公式列、毛利率列等）由实际上传的参考模板决定，
不在此处硬编码。此处仅配置业务规则和API参数。

路径说明：
  BACKEND_DIR = backend/ 目录
  BASE_DIR    = 项目根目录（backend/ 的父目录）
"""
import os

# ============================================================
# 路径配置
# ============================================================
BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
BASE_DIR = os.path.dirname(BACKEND_DIR)  # 项目根目录

# 全部数据（映射库、API 配置、上传、输出等）统一存放在项目主目录 data/ 下，
# 便于查看、备份、移植；目录被删除后会在下次启动时自动重建。
DATA_DIR = os.path.join(BASE_DIR, "data")

OUTPUT_DIR = os.path.join(DATA_DIR, "输出")      # 转换结果输出目录
UPLOAD_DIR = os.path.join(DATA_DIR, "uploads")   # 上传临时文件（自动清理）

# 用户系统数据目录：所有账户信息、邀请码、API Key 均以加密文件存储于此
# 位于项目主目录 data/users 下，随 data/ 一起统一备份、移植（删除后启动自动重建）
USERS_DIR = os.path.join(DATA_DIR, "users")

# 旧版用户数据目录（v1 曾存放于 backend/users），启动时自动迁移到 data/users 后删除
LEGACY_USERS_DIR = os.path.join(BACKEND_DIR, "users")

# 确保目录存在（删除后自动重建）
os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(OUTPUT_DIR, exist_ok=True)
os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(USERS_DIR, exist_ok=True)

# ============================================================
# DeepSeek API 配置
# ============================================================
# API Key 不再明文写在此处：由用户在网页「API 设置」中填写，
# 经加密后按账户存储于 data/users/api_keys.json（见 ai_config.py / user_system.py）。
# 未配置时 AI 匹配会提示用户先填写。
DEEPSEEK_API_URL = "https://api.deepseek.com/chat/completions"
# 官方有效模型名：deepseek-v4-flash / deepseek-v4-pro
# 注意：v4 系列默认开启「思考模式」，导致 message.content 为空（内容在 reasoning_content）。
# 必须在请求中显式设置 thinking={"type":"disabled"}（见 deepseek_matcher.call_deepseek_api）。
DEEPSEEK_MODEL = "deepseek-v4-flash"

# ============================================================
# 业务规则配置（以下内容可根据需要修改）
# ============================================================

# 注意：此处不再有任何硬编码列映射规则。
# 列名匹配完全依据用户上传表格的实际情况进行：
#   ① 精确匹配（列名完全相同）
#   ② 映射匹配库（用户历史确认的映射）
#   ③ AI 语义匹配（开启时）或本地模糊匹配（关闭时）

# 图片行高（磅）
IMAGE_ROW_HEIGHT_PT = 60
IMAGE_MARGIN_PT = 4

# ============================================================
# AI提示词模板
# ============================================================
HEADER_MATCHING_PROMPT = """你是一个Excel表格列名匹配专家。请将源表格的列名智能匹配到目标表格的列名。

## 匹配策略（重要！）：
你需要**综合两方面的信息**来判断两列是否匹配：
1. **表头名称**：列名的字面语义是否相近
2. **数据内容**：两列的实际数据值是否属于同一类型（如都是价格数字、都是型号代码、都是品牌名等）

## 重要规则：
1. 所有列（包括公式列）都同样参与映射匹配，一视同仁，不要跳过任何列
2. 优先匹配**列名完全相同**的列（表头名称一致，应直接一一对应）
3. 其次根据表头语义（近义词、包含关系）和数据内容类型来判断
4. 如果找不到合适的匹配，将该源列映射为null

## 目标表每列的数据样本：
{target_samples}

## 源表每列的数据样本：
{source_samples}

请以JSON格式返回映射结果，格式如下：
```json
{{"mappings": [{{"source_column": "源列名", "target_column": "目标列名", "confidence": "high/medium/low", "reason": "匹配理由"}}], "unmapped_sources": ["未能匹配的源列名"], "notes": "整体匹配说明"}}
```

注意：
- 只返回JSON，不要包含其他内容
- confidence取值：high（非常确定）、medium（比较确定）、low（猜测）
- 上述公式列不应出现在映射结果中
"""
