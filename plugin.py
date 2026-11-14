"""
QwenPaw 插件：Token 实时速度（纯前端，无后端路由）
- 前端 dist/index.js 拦截聊天 SSE 流，统计 TTFT / token 速度
- 后端仅提供最小插件对象，满足 QwenPaw 安装校验
"""
import logging

logger = logging.getLogger(__name__)


class TokenSpeedPlugin:
    def register(self, api):
        # 纯前端插件：不注册任何 HTTP 路由
        logger.info("TokenSpeed 插件已注册（纯前端，无后端路由）")


plugin = TokenSpeedPlugin()
