# 纯注册版

这个目录只保留邮箱注册流程：邮箱验证码、Password、About You、Session 持久化和结果导出。

输入列表会同时检查重复邮箱和重复接码链接。前端输入时即时提醒，服务端提交时会再次拦截，并返回重复行号。

没有复制旧项目的 `accounts.json`、`data`、工作流历史、提炼服务、扫码服务或上游凭据。第一次成功注册后，当前目录才会生成新的 `accounts.json`。这些运行时文件已加入 `.gitignore`，不会上传 GitHub。

启动：

```powershell
cd chatgpt-fuck-sign
$env:PORT='3032'
node server.js
```

浏览器打开 `http://127.0.0.1:3032`。端口、监听地址和默认并发可在 `config.txt` 修改；环境变量 `PORT`、`HOST` 会覆盖配置文件。

上传 GitHub 前只提交源代码、`package.json`、`README.md`、`config.txt` 和 `scripts/outlook_otp.py`。不要提交 `accounts.json`、`runtime`、`data`、Cookie、Session、Password 或任何 Token。
