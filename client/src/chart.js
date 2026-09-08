import Phaser from 'phaser';
import { PlaneScene } from './phaser/PlaneScene.js';

export function createChart(parent) {
  const scene = new PlaneScene();
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent,
    backgroundColor: '#4aa6e6',
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
    onPickup(fn) {
      scene.onPickup = fn;
    },
    onAirborne(fn) {
      scene.onAirborne = fn;
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
    setSpeed(n, durationMs) {
      scene.setSpeed(n);
      if (Number.isFinite(Number(durationMs)) && Number(durationMs) > 0) {
        scene.flightMs = Number(durationMs);
      }
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
    setEnergy(n) {
      scene.setEnergy?.(n);
    },
    crash(point, onSettled, missAt) {
      scene.crash(point, onSettled, missAt);
    },
    land(onSettled, landAt) {
      scene.land(onSettled, landAt);
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
