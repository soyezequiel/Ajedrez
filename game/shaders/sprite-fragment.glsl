#version 450
#include <layout.glsl>

void main() {
    vec4 color = texture(sampler2D(mainTexture, mainSampler), inputUv);
    if (color.a < 0.01) discard;
    outputColor = color;
}
