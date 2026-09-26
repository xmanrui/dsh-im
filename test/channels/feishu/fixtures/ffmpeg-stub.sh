#!/bin/sh
# 测试替身:不真正转码,只把 -i 指定的输入文件复制到最后一个参数(输出路径),
# 供 voice.test.mjs 在无 ffmpeg 的 CI 环境验证转写/合成管线。
input=
output=
expect_input=
for arg in "$@"; do
  if [ -n "$expect_input" ]; then
    input=$arg
    expect_input=
  elif [ "$arg" = "-i" ]; then
    expect_input=1
  else
    output=$arg
  fi
done
if [ -n "$input" ] && [ -n "$output" ]; then
  cp "$input" "$output"
fi
