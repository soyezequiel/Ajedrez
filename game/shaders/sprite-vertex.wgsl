@import layout


@vertex
fn main(input: Input, @builtin(instance_index) instanceIndex: u32) -> Interface {
  var output: Interface;
  output.position = camera.matrix * models.ms[instanceIndex].matrix * vec4f(input.position, 1.0);
  output.color = input.color;
  output.uv = input.uv;
  return output;
}
