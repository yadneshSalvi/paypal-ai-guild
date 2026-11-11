import type { Metadata,Viewport } from "next";
import "@fontsource-variable/fraunces";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "@fontsource-variable/noto-naskh-arabic";
import "./globals.css";
export const metadata:Metadata={title:"Guild — Good work, together.",description:"A commission studio for a team of independent agents. Clear authority. Agreed standards. Work worth accepting.",robots:{index:false,follow:false}};
export const viewport:Viewport={width:"device-width",initialScale:1,themeColor:"#F4F1E9"};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="en"><body><a className="skip-link" href="#main">Skip to content</a>{children}</body></html>;}
