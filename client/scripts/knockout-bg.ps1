param(
  [Parameter(Mandatory = $true)][string]$Src,
  [Parameter(Mandatory = $true)][string]$Dest
)

Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public static class PlaneKnockout {
  public static void Run(string src, string dest) {
    using (var srcImg = Image.FromFile(src))
    using (var bmp = new Bitmap(srcImg.Width, srcImg.Height, PixelFormat.Format32bppArgb))
    using (var g = Graphics.FromImage(bmp)) {
      g.DrawImage(srcImg, 0, 0, srcImg.Width, srcImg.Height);
      var rect = new Rectangle(0, 0, bmp.Width, bmp.Height);
      var data = bmp.LockBits(rect, ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
      int w = data.Width, h = data.Height, stride = data.Stride;
      byte[] px = new byte[stride * h];
      Marshal.Copy(data.Scan0, px, 0, px.Length);
      bool[] vis = new bool[w * h];
      int[] qx = new int[w * h];
      int[] qy = new int[w * h];
      int qs = 0, qe = 0;
      Action<int,int> push = (x, y) => {
        if (x < 0 || y < 0 || x >= w || y >= h) return;
        int i = y * w + x;
        if (vis[i]) return;
        int o = y * stride + x * 4;
        byte b = px[o], gch = px[o + 1], r = px[o + 2];
        int max = Math.Max(r, Math.Max(gch, b));
        int min = Math.Min(r, Math.Min(gch, b));
        double sat = max == 0 ? 0 : (max - min) / (double)max;
        if (sat >= 0.14 || max <= 145 || min <= 120) return;
        vis[i] = true;
        qx[qe] = x; qy[qe] = y; qe++;
      };
      for (int x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
      for (int y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
      while (qs < qe) {
        int x = qx[qs], y = qy[qs]; qs++;
        int o = y * stride + x * 4;
        px[o + 3] = 0;
        push(x - 1, y); push(x + 1, y); push(x, y - 1); push(x, y + 1);
      }
      Marshal.Copy(px, 0, data.Scan0, px.Length);
      bmp.UnlockBits(data);
      bmp.Save(dest, ImageFormat.Png);
    }
  }
}
"@

$destFull = [System.IO.Path]::GetFullPath($Dest)
$dir = Split-Path -Parent $destFull
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
if (Test-Path $destFull) { Remove-Item $destFull -Force }
[PlaneKnockout]::Run((Resolve-Path $Src).Path, $destFull)
Write-Output "saved $destFull"
