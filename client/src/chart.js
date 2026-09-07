import Phaser from 'phaser';
import { PlaneScene } from './phaser/PlaneScene.js';

export function createChart(parent) {
  const scene = new PlaneScene();
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent,
    backgroundColor: '#071433',
    scene,
    audio: { noAudio: true },
    banner: false,
    fps: {
      target: 60,
      min: 30,
      smoothStep: false,
    },
    render: {
      antialias: true,
      pixelArt: false,
      transparent: false,
      powerPreference: 'high-performance',
      batchSize: 1024,
    },
    scale: {
      mode: Phaser.Scale.RESIZE,
      autoCenter: Phaser.Scale.NO_CENTER,
      width: parent.clientWidth || 360,
      height: parent.clientHeight || 420,
    },
  });

  return {
    startFlying() {
      scene.setPhase('flying');
    },
    launch() {
      scene.launch();
    },
    applyRoundEvents(mod) {
      scene.applyRoundEvents(mod);
    },
    setActiveEvent(type) {
      scene.setActiveEvent(type);
    },
    isLaunched() {
      return Boolean(scene.launched);
    },
    abortLaunch() {
      scene.abortLaunch();
    },
    setSpeed(n) {
      scene.setSpeed(n);
    },
    setMultiplier(m) {
      scene.setMultiplier(m);
    },
    setCourse(m) {
      scene.setCourse(m);
    },
    setProgress(p) {
      scene.setProgress(p);
    },
    crash(point, onSettled) {
      scene.crash(point, onSettled);
    },
    land(onSettled) {
      scene.land(onSettled);
    },
    reset() {
      scene.setPhase('waiting');
    },
    labelPos() {
      return scene.label;
    },
    destroy() {
      game.destroy(true);
    },
  };
}
