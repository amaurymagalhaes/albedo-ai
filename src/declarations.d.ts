declare module "three";
declare module "pixi-live2d-display/cubism4" {
  export class Live2DModel {
    static registerTicker(ticker: any): void;
    static from(
      source: string | object,
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
  export class Live2DFactory {
    static runtimes: any[];
    static live2DModelMiddlewares: any[];
    static setupEssentials: any;
    static registerRuntime(runtime: any): void;
    static findRuntime(source: any): any;
  }
  export class Live2DLoader {
    static middlewares: any[];
  }
  export class Cubism4ModelSettings {
    static isValidJSON(json: any): boolean;
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
