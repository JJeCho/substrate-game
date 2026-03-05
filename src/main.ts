import './style.css';
import { MAP_WIDTH, MAP_HEIGHT, TILE_SIZE } from './game/constants';
import { Game } from './game/game';

const canvas = document.getElementById('game') as HTMLCanvasElement;
canvas.width = MAP_WIDTH * TILE_SIZE;
canvas.height = MAP_HEIGHT * TILE_SIZE;

const game = new Game(canvas);
(window as any).__game = game;
game.init();
game.start();
