#version 450
#include <layout.glsl>

void main() {
    gl_Position = camera.matrix * models.ms[gl_InstanceIndex] * vec4(inputPosition, 1.0);
    outputColor = inputColor;
    outputUv = inputUv;
}
