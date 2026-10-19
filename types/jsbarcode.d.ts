declare module "jsbarcode" {
  type JsBarcodeOptions = {
    format?: string;
    displayValue?: boolean;
    margin?: number;
    height?: number;
    width?: number;
    lineColor?: string;
    background?: string;
  };
  function JsBarcode(
    element: SVGSVGElement | HTMLCanvasElement | string,
    value: string,
    options?: JsBarcodeOptions,
  ): void;
  export default JsBarcode;
}
