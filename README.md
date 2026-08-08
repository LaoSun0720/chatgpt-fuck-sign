<div align="center">
  <a href="https://api.aixhub.vip">
    <img src="assets/aiapihub.png" width="150" alt="AI XHub">
  </a>
  <h2><a href="https://api.aixhub.vip">AI XHub 中转站</a></h2>
  <p><strong>不掺水的中转，骗人作者死全家，鸡鸡缩小，出门直接被撞死</strong></p>
  <p><a href="https://api.aixhub.vip">https://api.aixhub.vip</a></p>
</div>

---

# ChatGPT 批量注册工具

这是一个运行在 Windows 本地的批量注册面板。填写邮箱和对应的验证码收件链接后，程序会自动完成注册流程，并保存注册结果、随机密码和 Session。

支持的流程包括：

- 自动打开浏览器并填写邮箱
- 自动获取并提交邮箱验证码
- 兼容 `Password -> 验证码` 和 `验证码 -> Password` 两种页面顺序
- 新账号自动填写 About You，已有账号自动跳过
- 自动生成并保存随机密码
- 检查账号是否具有免费试用资格
- 注册成功后保存完整 Session
- 批量并发、暂停、继续和强制暂停
- 自动检查重复邮箱和重复接码链接
- 一键导出 Session

## 运行环境

- Windows 10 或 Windows 11
- Node.js 18 或更高版本
- Google Chrome
- Python 3（使用 Outlook 邮箱时需要）

## 安装

下载项目后进入项目目录，安装依赖：

```powershell
npm install
```

## 启动

可以直接双击：

```text
start.bat
```

也可以在项目目录运行：

```powershell
npm start
```

启动成功后打开：

```text
http://127.0.0.1:3032
```

## 输入格式

每行填写一个账号，邮箱和验证码收件链接之间使用四个短横线 `----` 分隔：

```text
user1@icloud.com----https://example.com/mail/user1
user2@icloud.com----https://example.com/mail/user2
```

输入后页面会自动检查：

- 邮箱格式是否正确
- 是否缺少验证码收件链接
- 是否存在重复邮箱
- 是否存在重复接码链接

检测到重复内容时，页面会显示对应行号，并禁止启动任务。

## 使用方法

1. 把邮箱和验证码收件链接粘贴到“邮箱列表”。
2. 设置注册并发，首次使用建议设置为 `1` 或 `2`。
3. 点击“开始注册”。
4. 在注册结果中查看每个账号的状态、Password 和 Session。
5. 任务完成后点击“导出 Session”保存结果。

任务运行期间可以点击“暂停”，当前正在处理的账号会继续完成，尚未开始的账号会等待。点击“强制暂停”会结束当前批次。

## 配置

打开 `config.txt` 可以修改本地服务配置：

```ini
PORT=3032
HOST=127.0.0.1
DEFAULT_CONCURRENCY=2
```

| 配置项 | 说明 |
| --- | --- |
| `PORT` | 网页面板端口 |
| `HOST` | 监听地址，默认只允许本机访问 |
| `DEFAULT_CONCURRENCY` | 默认注册并发，范围为 1-10 |

修改后重新启动程序即可生效。

## 数据保存

注册结果保存在项目目录下的 `accounts.json`。该文件会在首次产生结果后自动创建。

其中可能包含邮箱、随机密码和 Session，请自行保管，不要上传或转发。`accounts.json`、运行日志和临时浏览器数据已经加入 `.gitignore`。

## 常见问题

### 双击 start.bat 后窗口立即关闭

通常是没有安装 Node.js，或者项目依赖尚未安装。先在项目目录运行：

```powershell
npm install
npm start
```

命令行会显示具体错误信息。

### 页面打不开

确认命令行中出现下面的提示：

```text
纯注册服务已启动: http://127.0.0.1:3032
```

如果端口被占用，可以修改 `config.txt` 中的 `PORT`，然后重新启动。

### 一直等待验证码

先确认验证码收件链接能够正常打开，并且新邮件会出现在该页面。程序只读取本次注册请求之后收到的新验证码，不会使用旧邮件中的验证码。

### 为什么显示“无免费试用”

这表示账号注册或验证已经完成，但当前账号没有检测到免费试用资格。该结果会单独标记，不会当作普通注册异常。

### 刷新页面后怎么看之前的结果

点击页面中的“刷新”，程序会重新读取本地 `accounts.json` 并显示已经保存的记录。
