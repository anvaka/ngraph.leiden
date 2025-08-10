import { GLCollection, defineProgram, ColorAttribute, InstancedAttribute } from 'w-gl';

export default class SimplePointCollection extends GLCollection {
  constructor(gl, options = {}) {
    const program = defineProgram({
      gl,
      vertex: `
        uniform mat4 modelViewProjection;
        attribute float size;
        attribute vec3 position;
        attribute vec4 color;
        attribute vec2 point;
        varying vec4 vColor;
        varying vec2 vPoint;
        void main() {
          gl_Position = modelViewProjection * vec4(position + vec3(point * size, 0.), 1.0);
          vColor = color.abgr;
          vPoint = point;
        }
      `,
      fragment: `
        precision highp float;
        varying vec4 vColor;
        varying vec2 vPoint;
        void main() {
          float dist = length(vPoint);
          if (dist >= 0.5) discard;
          gl_FragColor = vColor;
        }
      `,
      attributes: { color: new ColorAttribute() },
      instanced: { point: new InstancedAttribute([ -0.5, -0.5, -0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, -0.5, -0.5, -0.5 ]) },
      preDrawHook() { return `gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);`; },
      postDrawHook() { return 'gl.disable(gl.DEPTH_TEST);'; }
    });
    super(program);
  }
}
