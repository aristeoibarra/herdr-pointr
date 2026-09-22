/**
 * The screenshot bundle, served at /screenshot.js and loaded on demand by
 * client/shot-loader.ts — see there for why it is not part of the widget.
 */
import { domToPng } from "modern-screenshot";

import "./shot-loader.ts";

window.__pointrDomToPng = domToPng;
