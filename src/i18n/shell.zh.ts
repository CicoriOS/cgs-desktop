// Strings of the window close prompt and the desktop update control (ADR 0046 §5, §6). Same pattern as settings.zh.ts.
export const shellZh = {
  "shell.close.title": "要关闭窗口吗？",
  "shell.close.body": "CGS Desktop 可以继续在后台运行，之后从托盘再打开。退出会中断正在运行的会话。",
  "shell.close.remember": "不再询问",
  "shell.close.background": "后台运行",
  "shell.close.quit": "退出",
  "shell.close.cancel": "取消",
  "shell.update.available": "有新版本 {version}",
  "shell.update.downloading": "正在下载更新 {percent}%",
  "shell.update.downloaded": "更新 {version} 已就绪",
  "shell.update.download": "下载",
  "shell.update.install": "重启并安装",
  "shell.update.error": "更新失败：{error}",
} as const;
