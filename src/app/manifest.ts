import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Control Horari",
    short_name: "Horari",
    description: "Control y seguimiento del fichaje automático en Timenet",
    start_url: "/",
    display: "standalone",
    background_color: "#f7f6f2",
    theme_color: "#047857",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
  };
}
