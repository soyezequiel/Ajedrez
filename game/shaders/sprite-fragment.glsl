#version 450
#include <layout.glsl>

void main() {
    outputColor = texture(sampler2D(mainTexture, mainSampler), inputUv);
}
