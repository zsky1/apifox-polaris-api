/* sample-http.js — 首次使用时写到默认工作目录的示例 .http（v0.6.2）
 * 内容参考了 AOS/AiLink 那套语音助手链路的形态（对话补全 + 声纹上传 + 表单登录），
 * 但域名、token、ID、字段全是虚构的占位值，不包含任何真实凭据。
 * __AUDIO_PATH__ 在写入时替换成本机默认目录下 sample-upload.txt 的绝对路径。
 */
(function () {
  var HTTP = String.raw`# ============================================================================
#  apifox · .http 示例集
#  这个文件是插件第一次打开时自动放到默认目录的样例，可以随便改、随便删。
#
#  怎么玩：
#    1) 顶栏「▤ 打开 .http」选文件；收起后点右缘灰色箭头能回到上次的文件
#    2) 每个请求左侧的 ▶ 一点即发，结果显示在下方的响应框里
#    3) Ctrl+S 保存；默认也会自动保存
#
#  语法速查：
#    ###  标题              分隔请求；标题就是侧栏里那条接口的名字
#    # @name xxx            给请求命名，之后可用 {{xxx.response.body.$.field}} 取上次的结果
#    @name = value          文件级变量（下面这几条），优先级高于 http-client.env.json
#    < 路径                 请求体整包来自文件；在 multipart 分段里则是「这一段的附件」（表单选「文件」填的就是这行）
#    WEBSOCKET ws://host/p  长连接；空行后第一条就是「连上就发」，=== 分隔后续消息
#    {{$guid}} {{$timestamp}} {{$randomInt}} {{$datetimeIso}}   内置动态变量
#
#  关于 # @file_id / # @interface_id（v1.0.0 起）：
#    第一次发送某个请求时，插件会自己往文件里补两行注释 ——
#      文件顶部  # @file_id xxxxxxxx      这个文件的身份
#      请求上面  # @interface_id xxxxxxxx  这个接口的身份
#    它们是**调用历史的钥匙**：每次发送都会往 _history/ 里记一行，靠它归属到具体接口。
#    别手动删这两行：删了就等于换了个身份，历史会断成两份（插件会提示"要接回吗"，点了才接）。
#    示例里**故意一个 id 都没有** —— 你自己发一次，它就有了。
#
#  想指向自己的服务：只改下面 @baseUrl / @apiBase 两行（@sseDemo 只给 6 号自测用）
# ============================================================================

@baseUrl = https://httpbin.org
@apiBase = https://api.example.com
@token = 换成你自己的 Bearer Token
@audioPath = __AUDIO_PATH__
@sseDemo = https://httpbingo.org

### 1. GET · 查询串 + 鉴权头
# @name listTasks
# 最普通的只读接口：查询参数直接跟在 URL 后面，改个值再点 ▶ 就能复跑。
# 有的网关只认裸 token（不加 "Bearer "），按你的服务改这一行即可。
# 发送一次之后，这里会多出一行 # @interface_id —— 那是这个接口的身份，别删（见文件顶部说明）。
GET {{baseUrl}}/get?familyId=1900000000000001&page=1&size=20&verbose=true
Accept: application/json
Authorization: Bearer {{token}}

### 2. POST · JSON 体 · 对话补全（OpenAI 兼容那一套）
# @name chatOnce
# 换成自己的服务：把 URL 改成 {{apiBase}}/v1/chat/completions。
# 注意 inputs.userData 这种字段是「被序列化过的 JSON 字符串」，里面的引号要转义。
POST {{baseUrl}}/post
Content-Type: application/json
Accept: application/json
Authorization: Bearer {{token}}

{
  "model": "gpt-turbo",
  "stream": false,
  "messages": [
    { "role": "system", "content": "你是家里的语音助手，回答不超过两句" },
    { "role": "user", "content": "客厅的热水器今天用了多少水？" }
  ],
  "inputs": {
    "instanceId": "{{$guid}}",
    "channelId": "1",
    "sentenceId": "1",
    "userData": "{\"familyId\":\"1900000000000001\",\"userId\":\"1700000000000001\",\"source\":\"3\",\"language\":\"1\"}"
  }
}

### 3. POST · 表单 application/x-www-form-urlencoded
# @name login
# 登录 / 换 token 最常见的形态：key=value&key=value，不是 JSON。
# 值里有中文或 & 时要先 URL 编码，否则会被切成两个字段。
POST {{baseUrl}}/post
Content-Type: application/x-www-form-urlencoded
Accept: application/json
X-Client: apifox

grant_type=password&username=apifox&password=123456&remember=true&nonce={{$randomInt}}

### 4. POST · multipart/form-data · 上传音频做声纹
# @name uploadVoice
# 这一节故意打 httpbin：响应里的 files.audio 会回显收到的字节，
# 用来确认「附件到底有没有真的带上」。
# 换成自己的上传接口：URL 改成 {{apiBase}}/voiceprint/uploadAudio?userId=1700000000000001
# 三个必须对齐的点：
#   · boundary 与 Content-Type 里写的一模一样
#   · 分段之间空一行，最后以 --boundary-- 收尾
#   · 附件路径写绝对路径（或本文件里的变量），< 后面留一个空格
POST {{baseUrl}}/post
Content-Type: multipart/form-data; boundary=ApifoxBoundary
Accept: application/json

--ApifoxBoundary
Content-Disposition: form-data; name="audio"; filename="sample.wav"
Content-Type: audio/wav

< {{audioPath}}
--ApifoxBoundary
Content-Disposition: form-data; name="scene"

voiceprint
--ApifoxBoundary
Content-Disposition: form-data; name="meta"
Content-Type: application/json

{"familyId":"1900000000000001","sampleRate":16000}
--ApifoxBoundary--

### 5. SSE · OpenAI 风格流式对话（data: 逐块 + data: [DONE]）
# @name chatStream
# 这是模板：URL 换成你的 /v1/chat/completions、token 填好就能跑。
# 服务端一行一条 data:，正文是增量 delta，最后一行 data: [DONE]：
#   data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"delta":{"content":"客"}}]}
#   data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"delta":{"content":"厅"}}]}
#   data: [DONE]
# 插件最多读 10 秒或读到对端断开，把已收到的行原样贴进响应框；
# 没正常收尾时响应区会标「SSE 已截断」，说明流是通的、只是还没说完。
POST {{apiBase}}/v1/chat/completions
Content-Type: application/json
Accept: text/event-stream
Cache-Control: no-cache
Authorization: Bearer {{token}}

{
  "model": "gpt-turbo",
  "stream": true,
  "messages": [
    { "role": "user", "content": "讲个三十字的小故事" }
  ],
  "inputs": { "instanceId": "{{$guid}}", "channelId": "1", "sentenceId": "1" }
}

### 6. SSE · 不花钱的流式自测（真正的 text/event-stream）
# 想看流是不是真的通，先点这个：httpbingo（httpbin 的 Go 版）每 2.5 秒推一条，
# 推 3 条就正常收尾，不会撞上插件那 10 秒上限，也不会被标成「已截断」。
# 注意：sidecar 是收完（对端断开或到上限）才把整段正文交回界面，
# 所以不是「逐字蹦出来」，而是结束后一次性出现。
GET {{sseDemo}}/sse?count=3
Accept: text/event-stream

### 7. 跨请求引用 · 把上一个请求的结果当变量
# @name reuseLogin
# 语法：{{请求名.response.body.$.字段路径}} · {{请求名.response.headers.头名}}
# 先跑 3 号「表单登录」，再点这里的 ▶，fromLogin 就会变成刚才表单里的用户名。
GET {{baseUrl}}/get?fromLogin={{login.response.body.$.form.username}}&trace={{listTasks.response.headers.X-Amzn-Trace-Id}}
Accept: application/json

### 8. 动态变量 · 每次发都是新的
# 用来造请求 id、幂等键、时间戳，省得手改。
GET {{baseUrl}}/get?guid={{$guid}}&ts={{$timestamp}}&at={{$datetimeIso}}&r={{$randomInt}}
Accept: application/json

### 9. 环境切换 · 变量放哪儿说了算
# @name envSwitch
# 优先级：文件里的 @xxx 最高，其次才是 http-client.env.json 里「当前环境」那一段。
# 所以想按环境换地址，就别在这个文件里写死它 —— 把上面 @baseUrl 那行删掉，
# 改成在 env 文件里给 local / dev 各写一份，右上角下拉一换就跟着变。
# 想藏密钥就用 http-client.private.env.json（同目录，不进 git）。
# 这一条用的是文件里没定义的 {{envTag}}：示例目录的 env 文件给了 local / dev 两个值，
# 切一下环境，发出去就能看到 ?env= 后面变了。
GET {{baseUrl}}/get?env={{envTag}}
Accept: application/json

### 10. WebSocket · 连上就发 + 多条消息
# @name wsDemo
# 方法下拉里选 WEBSOCKET（WS / WSS 简写也认）。它和普通请求共用同一个 tab、
# 同一个请求条：URL、请求头、Body 全复用，只是按钮变成「连接 / 断开」。
# 空行之后那一段 = 连上立刻发的第一条消息（这条示例故意只放一条，保持零提示）。
# 要多条就自己加：换行写 ===，再换行写第二条 —— 连上后先发第一条，其余在消息面板逐条发。
# 握手头（Authorization / Cookie / Sec-WebSocket-Protocol）必须写在这里，
# 连上之后再带就没用了 —— 它们只在握手那一刻有效。
# 这一条打公共 echo：发什么回什么，用来确认「连接 / 收发 / 断开」都通。
# 连不上（公司网络封了 WS）就换成自己的：ws://127.0.0.1:8080/echo
WEBSOCKET wss://echo.websocket.org
Accept: */*
Sec-WebSocket-Protocol: chat

{"type":"hello","from":"apifox"}

# ----------------------------------------------------------------------------
#  几个踩过的坑
#   · multipart 的 boundary 必须和 Content-Type 写的一致，分段之间空一行
#   · 附件写绝对路径；相对路径是按插件进程的工作目录解析的，容易踩空
#   · GET / HEAD 不能带 body，写了也不会发出去
#   · 变量没命中会原样发出去（URL 里还留着 {{ }}），点发送前先扫一眼
#   · 想按环境切地址：同目录放 http-client.env.json，右上角下拉能选
#   · WebSocket 的握手头写在请求行下面（不是连上之后），否则鉴权不会生效
# ----------------------------------------------------------------------------
`;

  var ATTACH = [
    'apifox 示例附件',
    '',
    '这个文件是 4 号请求（multipart/form-data）用的附件，',
    '换成你自己的 .wav 音频路径，就能真的上传音频做声纹。',
    ''
  ].join('\n');

  window.POLARIS_SAMPLE = { http: HTTP, attach: ATTACH, attachName: 'sample-upload.txt' };
})();
