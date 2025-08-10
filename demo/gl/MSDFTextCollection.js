import { defineProgram, InstancedAttribute, GLCollection } from 'w-gl';

export default class MSDFTextCollection extends GLCollection {
  constructor(gl, options = {}) {
    gl.getExtension('OES_standard_derivatives');
    super(getTextProgram(gl, options));

    this.isReady = false;
    this.queue = [];
  this.fontSize = options.fontSize || 1;
    this.fontInfo = null;
    this._sdfTextureChanged = false;

    const fontPath = options.fontPath || 'fonts';

    // Load font metrics
    fetch(`${fontPath}/Roboto.json`, { mode: 'cors' })
      .then((x) => x.json())
      .then((fontInfo) => {
        this.fontInfo = fontInfo;
        this.alphabet = new Map();
        fontInfo.chars.forEach((char) => {
          const charValue = String.fromCharCode(char.id);
          this.alphabet.set(charValue, char);
        });

        const img = (this.msdfImage = new Image());
        img.crossOrigin = 'Anonymous';
        img.onload = () => {
          this._sdfTextureChanged = true;
          this.program.setTextureCanvas('msdf', this.msdfImage);
          this.isReady = true;
          this.sdfTextureWidth = img.width;
          this.sdfTextureHeight = img.height;
          this.queue.forEach((q) => this.addText(q));
          this.queue = [];
          if (this.scene) this.scene.renderFrame();
        };
        img.src = `${fontPath}/Roboto0.png`;
      });
  }

  clear() {
    this.program.setCount(0);
  }

  draw(_, drawContext) {
    if (!this.uniforms) {
      this.uniforms = {
        modelViewProjection: this.modelViewProjection,
        color: [0.9, 0.9, 0.9, 1.0],
        bias: 0.5,
      };
    }
    // Outline pass
    this.uniforms.color[0] = 0.2;
    this.uniforms.color[1] = 0.4;
    this.uniforms.color[2] = 0.8;
    this.uniforms.color[3] = 0.8;
    this.uniforms.bias = 0.35;
    this.program.draw(this.uniforms);
    // Fill pass
    this.uniforms.color[0] = 0.95;
    this.uniforms.color[1] = 0.95;
    this.uniforms.color[2] = 0.95;
    this.uniforms.color[3] = 1;
    this.uniforms.bias = 0.5;
    this.program.draw(this.uniforms);
  }

  addText(textInfo) {
    if (!this.isReady) {
      this.queue.push(textInfo);
      return;
    }

    let { text, x = 0, y = 0, z = 0 } = textInfo;
    if (text === undefined) {
      throw new Error('Text is not defined in ' + textInfo);
    }

    let dx = 0;
    let fontSize = textInfo.fontSize || this.fontSize;
    if (textInfo.limit !== undefined) {
      // scale fontsize to fit a width
      let w = 0;
      for (let char of text) {
        const sdfPos = this.alphabet.get(char);
        if (!sdfPos) continue;
        w += sdfPos.xadvance;
      }
      if (w > 0) fontSize = (textInfo.limit * this.fontInfo.info.size) / w;
    }

    const scale = fontSize / this.fontInfo.info.size;
    if (textInfo.cx !== undefined) {
      let w = 0;
      for (let char of text) {
        const sdfPos = this.alphabet.get(char);
        if (!sdfPos) continue;
        w += sdfPos.xadvance;
      }
      dx -= w * textInfo.cx * scale;
    }
    if (textInfo.cy !== undefined) {
      y += fontSize * textInfo.cy;
    }

    const base = (this.fontInfo && this.fontInfo.info && this.fontInfo.info.size) || 42;
    for (let char of text) {
      const sdfPos = this.alphabet.get(char);
      if (!sdfPos) continue;

      this.add({
        position: [x + dx, y - sdfPos.yoffset * scale, z],
        charSize: [
          (fontSize * sdfPos.width) / base,
          (-fontSize * sdfPos.height) / base,
        ],
        texturePosition: [
          sdfPos.x / this.sdfTextureWidth,
          1 - sdfPos.y / this.sdfTextureHeight,
          sdfPos.width / this.sdfTextureWidth,
          -sdfPos.height / this.sdfTextureHeight,
        ],
      });
      dx += sdfPos.xadvance * scale;
    }
  }
}

function getTextProgram(gl, options) {
  return defineProgram({
    capacity: options.capacity || 1,
    buffer: options.buffer,
    debug: options.debug,
    gl,
    vertex: `
  uniform mat4 modelViewProjection;
  uniform vec4 color;

  // Position of the text character:
  attribute vec3 position;
  // Instanced quad coordinate:
  attribute vec2 point;
  attribute vec2 charSize;
  // [x, y, w, h] - of the character in the msdf texture.
  attribute vec4 texturePosition;

  varying vec2 vPoint;

  void main() {
    gl_Position = modelViewProjection * vec4(
      position + vec3(
        vec2(point.x, point.y) * charSize,
        position.z),
      1.);
    vPoint = texturePosition.xy + point * texturePosition.zw;
  }`,

    fragment: `
#ifdef GL_OES_standard_derivatives
#extension GL_OES_standard_derivatives : enable
#endif
  precision highp float;
  varying vec2 vPoint;

  uniform vec4 color;
  uniform float bias;
  uniform sampler2D msdf;

  float median(float r, float g, float b) {
    return max(min(r, g), min(max(r, g), b));
  }

  void main() {
    vec3 sample = texture2D(msdf, vPoint).rgb;
    float sigDist = median(sample.r, sample.g, sample.b) - bias;
    float alpha = clamp(sigDist / fwidth(sigDist) + bias, 0.0, 1.0);
    gl_FragColor = vec4(color.rgb, color.a * alpha);
  }`,
    instanced: {
      point: new InstancedAttribute([0, 0, 1, 0, 1, 1, 1, 1, 0, 0, 0, 1]),
    },
  });
}
