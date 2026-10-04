# 日签手写字体

- 字体：Long Cang，仅用于页脚日签。
- 版本：2.001；转换后保留 7,015 个字符映射。
- 来源：https://github.com/google/fonts/tree/main/ofl/longcang
- 上游：https://github.com/googlefonts/longcang
- 授权：SIL Open Font License 1.1；完整授权随应用包含在
  `public/fonts/LongCang-OFL.txt`。

`LongCang-Regular.woff2` 从上游同名 TTF 使用 FontTools 转换，
保留完整字符集，不裁切为当前日签子集，以便后续调整句子。
字形未改动。字体由 Vite 打包并在本地加载，不请求在线字体服务。

上游 TTF SHA-256：`e5bf2c3f24ef2327c6f136d8f73e2f9dfdf44896fdbeb35a9515f44777bb91bc`。

重新转换（需要 Python 的 fonttools 与 brotli）：

```sh
python -m fontTools.ttLib.woff2 compress LongCang-Regular.ttf -o src/assets/fonts/LongCang-Regular.woff2
```
