@import layout


@fragment
fn main(input: Interface) -> @location(0) vec4f {
  let color = textureSample(mainTexture, mainSampler, input.uv);
  if color.a < 0.01 {
    discard;
  }
  return color;
}
