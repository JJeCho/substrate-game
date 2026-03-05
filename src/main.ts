import './style.css';
import { MAP_WIDTH, MAP_HEIGHT, TILE_SIZE } from './game/constants';
import { Game } from './game/game';

const canvas = document.getElementById('game') as HTMLCanvasElement;
canvas.width = MAP_WIDTH * TILE_SIZE;
canvas.height = MAP_HEIGHT * TILE_SIZE;

function resizeCanvas(): void {
  const scaleX = window.innerWidth / canvas.width;
  const scaleY = window.innerHeight / canvas.height;
  const scale = Math.min(scaleX, scaleY);
  canvas.style.transform = `scale(${scale})`;
  canvas.style.transformOrigin = 'center center';
}

resizeCanvas();
window.addEventListener('resize', resizeCanvas);

const game = new Game(canvas);
(window as any).__game = game;
game.init();
game.start();
