@import layout


@fragment
fn main(input: Interface) -> @location(0) vec4f {
  return textureSample(mainTexture, mainSampler, input.uv);
}
