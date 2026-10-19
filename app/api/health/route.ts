import { NextResponse } from "next/server";
export function GET(){return NextResponse.json({status:"ok",mode:"development-foundation",databaseConnected:false,paymentsEnabled:false,productionReady:false},{headers:{"Cache-Control":"no-store"}});}
