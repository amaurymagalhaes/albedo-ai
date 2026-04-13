declare module "three";
declare module "pixi-live2d-display" {
  export class Live2DModel {
    static registerTicker(ticker: any): void;
    static from(
      modelPath: string,
      options?: { autoInteract?: boolean }
    ): Promise<Live2DModel>;
    static cubismReady: boolean;
    scale: { set(x: number, y?: number): void };
    anchor: { set(x: number, y: number): void };
    x: number;
    y: number;
    expression(name: string): void;
    motion(group: string, index?: number, priority?: any): void;
    destroy(): void;
    internalModel: {
      coreModel: {
        setParameterValueById(id: string, value: number): void;
        getParameterValueById(id: string): number;
        addParameterValueById(id: string, value: number): void;
      };
    };
  }
  export const config: {
    cubismCorePath: string;
  };
  export enum MotionPriority {
    IDLE = 0,
    NORMAL = 1,
    FORCE = 2,
  }
}
