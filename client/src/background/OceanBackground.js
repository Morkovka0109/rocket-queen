/** Pixels per second of the texture. Raise this to make the sea drift faster. */
export const BACKGROUND_SPEED = 40;

export const OCEAN_KEY = 'ocean';
export const OCEAN_ASSET = '/assets/background/ocean.jpg';
/** Horizon line inside the art, from the top of the image. */
export const OCEAN_HORIZON = 0.5;

/**
 * One complete seascape on screen. The TileSprite stays put; only the
 * texture scrolls on X so the same picture wraps without a second copy
 * sitting beside it.
 */
export class OceanBackground {
  /**
   * @param {Phaser.Scene} scene
   * @param {{ speed?: number, depth?: number, horizonScreen?: number }} [opts]
   */
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.speed = Number.isFinite(opts.speed) ? opts.speed : BACKGROUND_SPEED;
    this.depth = Number.isFinite(opts.depth) ? opts.depth : -20;
    this.horizonScreen = Number.isFinite(opts.horizonScreen) ? opts.horizonScreen : 0.632;
    this.sprite = null;
  }

  static preload(scene) {
    if (scene.textures.exists(OCEAN_KEY)) return;
    scene.load.image(OCEAN_KEY, OCEAN_ASSET);
  }

  create() {
    const w = Math.max(1, this.scene.scale.gameSize.width);
    const h = Math.max(1, this.scene.scale.gameSize.height);
    this.sprite = this.scene.add
      .tileSprite(0, 0, w, h, OCEAN_KEY)
      .setOrigin(0, 0)
      .setScrollFactor(0)
      .setDepth(this.depth);
    this.resize();
  }

  resize() {
    const sprite = this.sprite;
    const src = this.scene.textures.get(OCEAN_KEY)?.getSourceImage?.();
    if (!sprite || !src?.width || !src.height) return;

    const w = Math.max(1, this.scene.scale.gameSize.width);
    const h = Math.max(1, this.scene.scale.gameSize.height);
    const imgW = src.width;
    const imgH = src.height;

    sprite.setPosition(0, 0);
    sprite.setSize(w, h);
    sprite.setScale(1);
    sprite.setDisplaySize(w, h);

    // Cover the view with a single copy of the art (no stretch, no second
    // picture beside it). Extra scale keeps the painted horizon on the
    // game waterline so ships sit in the same scene.
    const scale = Math.max(
      w / imgW,
      h / imgH,
      (this.horizonScreen / OCEAN_HORIZON) * (h / imgH),
    );
    sprite.tileScaleX = scale;
    sprite.tileScaleY = scale;

    const shown = h / scale;
    let originY = imgH * OCEAN_HORIZON - this.horizonScreen * shown;
    originY = Math.max(0, Math.min(imgH - shown, originY));
    sprite.tilePositionY = originY;
  }

  /**
   * @param {number} delta Frame delta in milliseconds.
   */
  update(delta) {
    if (!this.sprite) return;
    this.sprite.tilePositionX += this.speed * (Math.max(0, delta) / 1000);
  }

  destroy() {
    this.sprite?.destroy();
    this.sprite = null;
  }
}
