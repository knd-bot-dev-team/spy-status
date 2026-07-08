import aiohttp
from astrbot.api import AstrBotConfig, logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star, register


@register(
    "astrbot_plugin_spy_status",
    "knd-bot-dev-team",
    "查询雨核、皮梦等成员的桌面在线状态",
    "1.0.0",
    "https://github.com/knd-bot-dev-team/spy-status",
)
class SpyStatusPlugin(Star):
    """视奸状态插件：按 AstrBot 插件规范实现的状态查询入口。"""

    def __init__(self, context: Context, config: AstrBotConfig):
        super().__init__(context)
        self.config = config
        self.api_base = (config.get("api_base") or "https://shijian.07210700.xyz").rstrip("/")
        self.timeout = max(1, int(config.get("timeout", 10)))
        self.default_name = config.get("default_name") or "雨核"

    @filter.command("status")
    async def status(self, event: AstrMessageEvent):
        '''查询指定成员的桌面状态，用法：/status [名字]，默认查询雨核'''
        args = event.message_str.split()
        name = args[1] if len(args) > 1 else self.default_name

        try:
            events = await self._fetch_status(name)
        except Exception as e:
            logger.error("[spy-status] 查询 %s 失败: %s", name, e)
            yield event.plain_result(f"查询 {name} 状态失败：{e}")
            return

        if not events:
            yield event.plain_result(f"暂无 {name} 的状态数据。")
            return

        yield event.plain_result(self._format(name, events))

    async def _fetch_status(self, name: str, limit: int = 5) -> list:
        """调用远程 /api/current-status 接口获取某人的最新事件。"""
        url = f"{self.api_base}/api/current-status?name={name}&limit={limit}"
        timeout = aiohttp.ClientTimeout(total=self.timeout)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(url) as resp:
                resp.raise_for_status()
                data = await resp.json()
                return data if isinstance(data, list) else []

    def _format(self, name: str, events: list) -> str:
        """把最新一条事件格式化为可读的纯文本。"""
        ev = events[0]
        raw_title = ev.get("window_title") or ev.get("app") or "未知"
        app_name = raw_title.split(" - ")[0] if " - " in raw_title else raw_title
        machine = ev.get("machine", "未知设备")
        access_time = ev.get("access_time", "未知时间")
        return f"【{name}】\n设备：{machine}\n应用：{app_name}\n时间：{access_time}"

    async def terminate(self):
        '''插件被卸载/停用时调用，可用于释放资源。'''
        pass
