/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import AirCombatPlatform from './components/AirCombatPlatform';
import { audioManager } from './game/audio';

export default function App() {
  const [gameState, setGameState] = useState<'menu' | 'playing'>('menu');
  const [lastScore, setLastScore] = useState<number | null>(null);

  const startGame = () => {
    audioManager.init();
    setGameState('playing');
  };

  const returnToMenu = (score: number) => {
    setLastScore(score);
    setGameState('menu');
  };

  return (
    <div className="w-screen h-screen overflow-hidden bg-slate-900 text-white font-mono select-none">
      {gameState === 'menu' && (
        <div className="flex flex-col items-center justify-center w-full h-full p-8 relative">
          <div className="absolute inset-0 z-0">
             {/* abstract background pattern */}
             <div className="w-full h-full bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-blue-900/20 via-slate-900 to-slate-900"></div>
          </div>
          
          <div className="z-10 flex flex-col items-center max-w-md w-full bg-slate-800/80 p-12 border border-slate-700 shadow-2xl backdrop-blur-md rounded-xl">
             <div className="mb-8 text-center space-y-4">
                <h1 className="text-4xl font-black text-emerald-400 tracking-widest drop-shadow-[0_0_15px_rgba(52,211,153,0.5)]">空战模拟系统</h1>
                <p className="text-slate-400 text-sm tracking-widest">代号：无尽长空</p>
             </div>
             
             {lastScore !== null && (
               <div className="mb-8 p-4 bg-slate-900/50 w-full text-center rounded border border-slate-700">
                  <div className="text-slate-400 text-sm mb-1">上次任务得分</div>
                  <div className="text-3xl text-emerald-400 font-bold">{lastScore}</div>
               </div>
             )}

             <div className="flex flex-col gap-4 w-full">
               <button 
                 onClick={startGame}
                 className="w-full py-4 bg-emerald-500 hover:bg-emerald-400 text-slate-900 font-bold tracking-widest transition-all shadow-[0_0_20px_rgba(16,185,129,0.3)] hover:shadow-[0_0_30px_rgba(16,185,129,0.6)] rounded">
                 {lastScore !== null ? '重新部署' : '开始游戏'}
               </button>
               
               <button 
                 onClick={() => { window.location.reload(); }} // Exit by reloading/closing context
                 className="w-full py-3 bg-slate-700 hover:bg-slate-600 text-white font-bold tracking-widest transition-all rounded">
                 退出系统
               </button>
             </div>
             
             <div className="mt-12 text-center text-xs text-slate-500">
               歼-20 威龙操作界面 V1.0.4
             </div>
          </div>
        </div>
      )}
      
      {gameState === 'playing' && (
        <AirCombatPlatform onGameOver={returnToMenu} />
      )}
    </div>
  );
}
