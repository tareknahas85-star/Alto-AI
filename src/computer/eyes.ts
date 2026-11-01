// Desktop Copilot — "eyes": local OCR of the screen (Windows built-in OCR engine, Arabic + English, nothing leaves the PC)
// and the foreground window. Read-only: same trust level as pc_screenshot.

type Handler = (a: Record<string, unknown>) => Promise<string>
type Def = (name: string, description: string, props: Record<string, unknown>, required: string[], h: Handler) => void
type RunPs = (script: string, args?: unknown, timeoutMs?: number, signal?: AbortSignal) => Promise<string>

const num = { type: 'number' }
const str = { type: 'string' }

const OCR_PS = String.raw`
Add-Type -AssemblyName System.Drawing, System.Windows.Forms, System.Runtime.WindowsRuntime
$v=[Windows.Forms.SystemInformation]::VirtualScreen
$x=$v.Left; $y=$v.Top; $w=$v.Width; $h=$v.Height
if($A.w -gt 0 -and $A.h -gt 0){ $x=[int]$A.x; $y=[int]$A.y; $w=[int]$A.w; $h=[int]$A.h }
$bmp=New-Object Drawing.Bitmap $w,$h
$g=[Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($x,$y,0,0,$bmp.Size); $g.Dispose()
$p=Join-Path $env:TEMP ('trl-ocr-'+[guid]::NewGuid().ToString('N')+'.png'); $bmp.Save($p,[Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
try {
$null=[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]
$null=[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
$null=[Windows.Graphics.Imaging.BitmapDecoder,Windows.Foundation,ContentType=WindowsRuntime]
$null=[Windows.Globalization.Language,Windows.Globalization,ContentType=WindowsRuntime]
$asTask=([System.WindowsRuntimeSystemExtensions].GetMethods()|Where-Object{$_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation` + "`1" + String.raw`'})[0]
function Await($op,$type){$t=$asTask.MakeGenericMethod($type).Invoke($null,@($op));[void]$t.Wait(-1);$t.Result}
$f=Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($p)) ([Windows.Storage.StorageFile])
$s=Await ($f.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$d=Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($s)) ([Windows.Graphics.Imaging.BitmapDecoder])
$sb=Await ($d.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$want=@(); if($A.lang -eq 'ar'){$want=@('ar')}elseif($A.lang -eq 'en'){$want=@('en-US')}else{$want=@('ar','en-US')}
$out=@()
foreach($t in $want){
  $e=$null; try{ $e=[Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new($t)) }catch{}
  if(-not $e){ $out+=('['+$t+'] (لغة OCR مو منزّلة بالويندوز)'); continue }
  $r=Await ($e.RecognizeAsync($sb)) ([Windows.Media.Ocr.OcrResult])
  if($r.Text.Trim()){ $out+=('['+$t+']'+[Environment]::NewLine+$r.Text.Trim()) }
}
if(-not $out){ 'ما لقيت نص على الشاشة.' } else { $out -join ([Environment]::NewLine+[Environment]::NewLine) }
} finally { Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue }
`

const WIN_PS = String.raw`
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public class TrlFg { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
 [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; } }
"@
$h=[TrlFg]::GetForegroundWindow()
$sb=New-Object Text.StringBuilder 512; [void][TrlFg]::GetWindowText($h,$sb,512)
$procId=0; [void][TrlFg]::GetWindowThreadProcessId($h,[ref]$procId)
$r=New-Object TrlFg+RECT; [void][TrlFg]::GetWindowRect($h,[ref]$r)
$pr=Get-Process -Id $procId -ErrorAction SilentlyContinue
[pscustomobject]@{ title=$sb.ToString(); process=$pr.ProcessName; pid=$procId; x=$r.L; y=$r.T; width=($r.R-$r.L); height=($r.B-$r.T) } | ConvertTo-Json -Compress
`

export function addEyesTools(def: Def, runPs: RunPs): void {
  def(
    'pc_ocr',
    'اقرأ النص اللي على الشاشة بـ OCR محلي (عربي + إنجليزي، ما بيطلع شي من الجهاز). بدون وسائط بيقرأ كل الشاشة؛ أو حدد منطقة x,y,width,height بإحداثيات الشاشة. lang: auto|ar|en. استعمله لمّا الموديل ما بيشوف الصور أو لقراءة نافذة ما إلها UI snapshot.',
    { x: num, y: num, width: num, height: num, lang: str },
    [],
    async (a) => {
      const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : 0)
      const w = n(a.width)
      const h = n(a.height)
      if ((w > 0) !== (h > 0)) return 'Error: حدد width وheight مع بعض (أو بلا منطقة لقراءة كل الشاشة).'
      if (w > 0 && (w > 10000 || h > 10000 || n(a.x) < -10000 || n(a.y) < -10000)) return 'Error: منطقة خارج الحدود.'
      const lang = a.lang === 'ar' || a.lang === 'en' ? a.lang : 'auto'
      return runPs(OCR_PS, { x: n(a.x), y: n(a.y), w, h, lang }, 45000)
    }
  )
  def('pc_active_window', 'النافذة اللي عليها التركيز هلأ: العنوان، البرنامج، المعرّف وموقعها وحجمها.', {}, [], async () => runPs(WIN_PS, {}, 15000))
}

export function eyesToolsInfo(): { name: string; description: string }[] {
  const out: { name: string; description: string }[] = []
  addEyesTools((name, description) => { out.push({ name, description: description.split(' بدون وسائط')[0] }) }, (async () => '') as RunPs)
  return out
}
