export const mapFringe=.16;
export const maxZoom=2.75;
export const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));

export function cameraLimits({width,height,stageWidth,stageHeight}) {
  const horizontal=stageWidth*(1+2*mapFringe), vertical=stageHeight*(1+2*mapFringe);
  const minimum=horizontal>0&&vertical>0?Math.max(.82,width/horizontal,height/vertical):.82;
  return {horizontal,vertical,minimum,maximum:Math.max(maxZoom,minimum)};
}

export function constrainCamera(camera,dimensions) {
  const {horizontal,vertical,minimum,maximum}=cameraLimits(dimensions);
  const scale=clamp(camera.scale,minimum,maximum);
  const limitX=Math.max(0,(horizontal*scale-dimensions.width)/2);
  const limitY=Math.max(0,(vertical*scale-dimensions.height)/2);
  return {scale,dx:clamp(camera.dx,-limitX,limitX),dy:clamp(camera.dy,-limitY,limitY)};
}

// Keep the same part of the painted atlas beneath the mouse or pinch midpoint.
export function moveCamera(camera,dimensions,scale,from,to=from) {
  const {minimum,maximum}=cameraLimits(dimensions);
  const zoom=clamp(scale,minimum,maximum), ratio=zoom/camera.scale;
  return constrainCamera({
    scale:zoom,dx:to[0]-(from[0]-camera.dx)*ratio,dy:to[1]-(from[1]-camera.dy)*ratio,
  },dimensions);
}
