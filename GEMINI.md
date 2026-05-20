# Air Combat Simulator (无尽长空)

## Project Overview
Air Combat Simulator is a 2D web-based game built using HTML5 Canvas for core rendering and React for the modern UI/HUD overlay. The application simulates an air combat environment featuring player maneuverability, intelligent enemy spawning, boss encounters, collision detection, and custom audio synthesis.

### Tech Stack
- **Frontend Framework:** React 19, TypeScript
- **Build Tool:** Vite 6
- **Styling:** Tailwind CSS v4
- **Animation:** Motion (`motion`)
- **Game Rendering:** HTML5 `<canvas>` API
- **Audio:** Web Audio API (Procedural sound synthesis via Oscillators)

## Architecture & Key Directories
The project strictly separates the React presentation layer from the game's internal simulation and rendering logic.

- **`src/components/AirCombatPlatform.tsx`**: The main React component acting as the container for the game canvas and the high-tech HUD layer. It binds the React UI to the underlying game engine's state.
- **`src/game/controller.ts`**: The core game engine. Manages the main game loop, physics updates, rendering calls, collision detection, and the scheduling of enemy/boss spawns.
- **`src/game/model.ts`**: Contains the logic and behavior implementations for game entities (Player, Enemies, Missiles, Lasers, Bosses).
- **`src/game/audio.ts`**: A procedural audio engine utilizing the Web Audio API to generate retro-electronic sound effects (missiles, explosions, warnings) dynamically without external assets.
- **`src/game/interfaces.ts`**: TypeScript definitions enforcing strong typing across the game engine.

## Building and Running

The project relies on `npm` as the package manager (indicated by `package-lock.json`).

```bash
# Install dependencies
npm install

# Start the local development server (runs on port 3000)
npm run dev

# Run TypeScript compiler for linting/type-checking
npm run lint

# Build the project for production
npm run build
```

## Development Conventions
- **Package Manager:** Strictly use `npm`. Do not use `yarn` or `pnpm`.
- **Canvas vs. DOM:** Game entities and combat logic must be rendered onto the Canvas (`src/game/*`). React and Tailwind CSS should only be used for UI elements, menus, and the Heads-Up Display (HUD).
- **Audio Implementation:** When adding new sounds, extend the `audio.ts` procedural synthesis rather than importing static `.mp3` or `.wav` files unless explicitly required.
- **Typing:** Ensure all new game entities and states are properly typed in `src/game/interfaces.ts`. Maintain strict TypeScript conventions.
