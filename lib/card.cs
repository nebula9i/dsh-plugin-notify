// dsh-plugin-notify - the notification card, drawn by the helper process.
//
// ## It notifies; it does not answer
//
// The card shows what is being asked and nothing else. There are no answer
// buttons: clicking the card brings the chat forward, and the answer is given
// there. That is deliberate. The chat client owns each pending question through
// its own waterfall channel, and answering out-of-band leaves that channel
// unsettled - the client then keeps the question card on screen with nothing
// able to settle it. A notification cannot fix that, so it does not try.
//
// Several questions from one request share a card as TABS, the way the chat
// presents them; separate cards are reserved for separate chats.
//
// ## Why a plain window with a Region, not a layered window
//
// An earlier version used a layered window (WS_EX_LAYERED + UpdateLayeredWindow),
// the only way to get antialiased rounded corners *and* a genuinely soft shadow.
// It was replaced after a long debugging session in which it appeared never to
// display - a diagnosis that turned out to rest on a broken screen-capture
// method. This version is kept because it is simpler and demonstrably displays.
// The corners are clipped rather than antialiased.
//
// ## Stacking: each card is its own process, coordinated through a file
//
// Cards persist, and a card from a new chat pushes the older ones up and starts
// their countdown. The cards cannot talk to each other (each is a separate
// powershell.exe, and piped stdio is unusable under the DSH file sandbox), so the
// plugin writes a shared LAYOUT file and every card polls it:
//
//     <cardId>|<countdownSeconds>      one line per card, newest first
//
// Index 0 is the newest card and sits at the bottom, nearest the corner; index 1
// sits above it, and so on. A card at index > 0 has been pushed up: it starts its
// countdown once and closes when it expires. A card that returns to index 0
// (because the cards below it were dismissed) stops counting and stays.
//
// Heights are deliberately not in the layout file: each card writes its own
// `<cardId>.size` beside it, so a card positions itself from the REAL heights of
// the cards below it instead of an estimate the plugin would have to duplicate.

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

namespace DshNotify
{
    public class TabSpec
    {
        public string Label = "";
        public string Body = "";
    }

    public class CardSpec
    {
        public string CardId = "";
        public string Accent = "#4D6BFE";
        // Without a heading a single-question card is a 47px strip of body text
        // that reads as a rendering artifact rather than a notification, and with
        // no buttons there is nothing left to suggest it can be clicked at all.
        public string Heading = "";
        public string Hint = "";
        public bool Sound = true;
        public bool FocusOnClick = true;
        public string LayoutPath = "";
        public string LogPath = "";
        public int AutoClickMs = 0;       // test affordance: act as if the card was clicked
        public int AutoCloseMs = 0;       // test affordance: dismiss after this long (0 = never)
        public string DumpPng = "";       // test affordance: save a bitmap of the card
        public List<TabSpec> Tabs = new List<TabSpec>();
    }

    internal static class Diag
    {
        public static void Write(string path, string message)
        {
            if (string.IsNullOrEmpty(path)) return;
            try
            {
                File.AppendAllText(path,
                    DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ") + " helper: " + message + "\r\n",
                    new UTF8Encoding(false));
            }
            catch { }
        }
    }

    public class CardForm : Form
    {
        [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr hWnd, IntPtr after,
            int X, int Y, int cx, int cy, uint uFlags);

        private const uint SWP_NOSIZE = 0x0001;
        private const uint SWP_NOACTIVATE = 0x0010;
        private static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
        // Not named Margin: that hides Form.Margin, and Add-Type treats the
        // resulting warning as an error.
        private const int EdgeMargin = 8;
        private const int StackGap = 10;
        private const int FallbackHeight = 120;

        private readonly CardSpec _spec;
        private readonly float _scale;
        private readonly int _radius;
        private readonly int _width;
        private readonly int _height;
        private readonly Color _accent;
        private readonly string _sizePath;
        // Written by the plugin when the question is answered in the chat, so the
        // card can retire itself instead of lingering after the answer.
        private readonly string _closePath;
        private readonly Rectangle _area;
        private readonly List<TabSpec> _tabs;
        private readonly List<Button> _tabButtons = new List<Button>();
        private readonly Timer _tick;
        private readonly Timer _poll;
        private readonly Timer _autoClose;
        private int _active;
        private int _targetX, _targetY, _startX;
        // Must start at 0. The window is created parked at _startX (off the right
        // edge) and only the slide timer moves it in; starting at 1 means "already
        // arrived", so the card renders perfectly and stays off-screen forever.
        private float _slideT;
        private bool _slideLogged;
        private bool _settled;
        private bool _dismissing;
        private bool _closeHover;
        private bool _counting;
        private DateTime _countdownEnds = DateTime.MinValue;
        private int _countdownTotalMs;

        protected override bool ShowWithoutActivation { get { return true; } }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.ExStyle |= 0x08000000; // WS_EX_NOACTIVATE
                cp.ExStyle |= 0x00000080; // WS_EX_TOOLWINDOW (no taskbar button)
                cp.ClassStyle |= 0x00020000; // CS_DROPSHADOW
                return cp;
            }
        }

        public CardForm(CardSpec spec)
        {
            _spec = spec;
            _tabs = spec.Tabs ?? new List<TabSpec>();

            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            TopMost = true;
            StartPosition = FormStartPosition.Manual;
            BackColor = Color.FromArgb(30, 31, 34);
            DoubleBuffered = true;
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint, true);
            Cursor = Cursors.Hand; // the whole card is one big "go to the chat" target

            // Never CreateGraphics() here: on a Control it forces handle creation,
            // which runs OnHandleCreated from inside this constructor. A screen DC
            // gives the same DPI without touching the form's handle.
            using (Graphics probe = Graphics.FromHwnd(IntPtr.Zero)) _scale = probe.DpiX / 96f;
            float scale = _scale <= 0f ? 1f : _scale;
            _radius = (int)Math.Round(12 * scale);
            _width = (int)Math.Round(400 * scale);
            _accent = Parse(spec.Accent, Color.FromArgb(0x4D, 0x6B, 0xFE));
            _area = Screen.PrimaryScreen.WorkingArea;
            _sizePath = string.IsNullOrEmpty(spec.LayoutPath) || string.IsNullOrEmpty(spec.CardId)
                ? ""
                : Path.Combine(Path.GetDirectoryName(spec.LayoutPath), spec.CardId + ".size");
            _closePath = string.IsNullOrEmpty(_sizePath) ? "" : _sizePath.Replace(".size", ".close");

            int pad = (int)Math.Round(16 * scale);
            int contentX = (int)Math.Round(4 * scale) + (int)Math.Round(14 * scale);
            int contentW = _width - contentX - pad;

            int y = (int)Math.Round(15 * scale);
            if (!string.IsNullOrEmpty(spec.Heading))
            {
                Controls.Add(new Label
                {
                    Name = "heading",
                    Text = spec.Heading,
                    Font = new Font("Segoe UI", 10.5f, FontStyle.Bold, GraphicsUnit.Point),
                    ForeColor = Color.FromArgb(242, 243, 245),
                    BackColor = Color.Transparent,
                    AutoSize = false,
                    UseMnemonic = false,
                    Cursor = Cursors.Hand,
                    // Leaves room for the close button at the right edge.
                    Bounds = new Rectangle(contentX, y, contentW - (int)Math.Round(26 * scale), (int)Math.Round(21 * scale)),
                });
                y += (int)Math.Round(21 * scale) + (int)Math.Round(7 * scale);
            }
            if (_tabs.Count > 1) y += BuildTabStrip(contentX, y, contentW);

            // Size to the TALLEST tab so switching tabs never resizes the card.
            int tallest = 0;
            for (int i = 0; i < _tabs.Count; i++)
            {
                tallest = Math.Max(tallest, MeasureTab(contentX, contentW, _tabs[i]));
            }
            y += tallest;

            // The click affordance. With the answer buttons gone this is the only
            // thing telling the user what clicking the card will do.
            if (!string.IsNullOrEmpty(spec.Hint))
            {
                y += (int)Math.Round(7 * scale);
                Controls.Add(new Label
                {
                    Name = "hint",
                    Text = spec.Hint,
                    Font = new Font("Segoe UI", 8f, FontStyle.Regular, GraphicsUnit.Point),
                    ForeColor = Color.FromArgb(120, 126, 138),
                    BackColor = Color.Transparent,
                    AutoSize = false,
                    UseMnemonic = false,
                    Cursor = Cursors.Hand,
                    Bounds = new Rectangle(contentX, y, contentW, (int)Math.Round(14 * scale)),
                });
                y += (int)Math.Round(14 * scale);
            }

            _height = y + (int)Math.Round(15 * scale);
            ClientSize = new Size(_width, _height);

            BuildTabBody(contentX, BodyTop(), contentW);

            _targetX = _area.Right - _width - (int)Math.Round(EdgeMargin * scale);
            _targetY = _area.Bottom - _height - (int)Math.Round(EdgeMargin * scale);
            _startX = _area.Right;

            _tick = new Timer { Interval = 15 };
            _tick.Tick += OnTick;
            _poll = new Timer { Interval = 250 };
            _poll.Tick += (s, e) => OnPoll();
            _autoClose = new Timer { Interval = Math.Max(200, spec.AutoCloseMs) };
            _autoClose.Tick += (s, e) => { _autoClose.Stop(); Dismiss("autoclose"); };

            if (spec.AutoClickMs > 0)
            {
                var probe = new Timer { Interval = Math.Max(100, spec.AutoClickMs) };
                probe.Tick += (ts, te) => { probe.Stop(); OpenChat(); };
                probe.Start();
            }
        }

        // ------------------------------------------------------------------ tabs

        /// A single row of equal-width tabs, one per question. Navigation only:
        /// answering happens in the chat, so these are not answer buttons.
        private int BuildTabStrip(int contentX, int y, int contentW)
        {
            int stripH = (int)Math.Round(24 * _scale);
            int gap = (int)Math.Round(4 * _scale);
            int count = Math.Max(1, _tabs.Count);
            int each = (contentW - gap * (count - 1)) / count;

            for (int i = 0; i < _tabs.Count; i++)
            {
                int index = i;
                var tab = new Button
                {
                    Name = "tab:" + i,
                    Text = Shorten(_tabs[i].Label, each - (int)Math.Round(12 * _scale)),
                    Font = new Font("Segoe UI", 8.5f, FontStyle.Regular, GraphicsUnit.Point),
                    FlatStyle = FlatStyle.Flat,
                    UseVisualStyleBackColor = false,
                    TabStop = false,
                    Bounds = new Rectangle(contentX + i * (each + gap), y, each, stripH),
                    Cursor = Cursors.Hand,
                    TextAlign = ContentAlignment.MiddleCenter,
                };
                tab.FlatAppearance.BorderSize = 1;
                StyleTab(tab, i == _active);
                tab.Click += (s, e) =>
                {
                    if (_settled) return;
                    _active = index;
                    RestyleTabs();
                    RebuildBody();
                };
                Controls.Add(tab);
                _tabButtons.Add(tab);
            }
            return stripH + (int)Math.Round(10 * _scale);
        }

        private void StyleTab(Button tab, bool active)
        {
            if (active)
            {
                tab.BackColor = Color.FromArgb(43, 46, 52);
                tab.ForeColor = Color.FromArgb(242, 243, 245);
                tab.FlatAppearance.BorderColor = Color.FromArgb(80, 86, 96);
            }
            else
            {
                tab.BackColor = Color.FromArgb(30, 31, 34);
                tab.ForeColor = Color.FromArgb(150, 155, 164);
                tab.FlatAppearance.BorderColor = Color.FromArgb(52, 55, 61);
            }
            tab.FlatAppearance.MouseOverBackColor = Color.FromArgb(38, 40, 45);
            tab.FlatAppearance.MouseDownBackColor = Color.FromArgb(28, 29, 32);
        }

        private void RestyleTabs()
        {
            for (int i = 0; i < _tabButtons.Count; i++) StyleTab(_tabButtons[i], i == _active);
        }

        /// Height the given tab's body needs.
        private int MeasureTab(int contentX, int contentW, TabSpec tab)
        {
            if (string.IsNullOrEmpty(tab.Body)) return 0;
            var bodyFont = new Font("Segoe UI", 9f, FontStyle.Regular, GraphicsUnit.Point);
            Size measured = TextRenderer.MeasureText(tab.Body, bodyFont, new Size(contentW, 1000), TextFormatFlags.WordBreak);
            int lines = Math.Max(1, Math.Min(4, (int)Math.Ceiling(measured.Height / (17.0 * _scale))));
            return (int)Math.Round(lines * 17 * _scale);
        }

        /// Draw the active tab's question text.
        private void BuildTabBody(int contentX, int y, int contentW)
        {
            for (int i = Controls.Count - 1; i >= 0; i--)
            {
                if (Controls[i].Name != null && Controls[i].Name.StartsWith("body:")) Controls.RemoveAt(i);
            }

            TabSpec tab = _tabs.Count > 0 ? _tabs[Math.Min(_active, _tabs.Count - 1)] : null;
            if (tab == null || string.IsNullOrEmpty(tab.Body)) return;

            var bodyFont = new Font("Segoe UI", 9f, FontStyle.Regular, GraphicsUnit.Point);
            Size measured = TextRenderer.MeasureText(tab.Body, bodyFont, new Size(contentW, 1000), TextFormatFlags.WordBreak);
            int lines = Math.Max(1, Math.Min(4, (int)Math.Ceiling(measured.Height / (17.0 * _scale))));
            var label = new Label
            {
                Name = "body:" + _active,
                Text = tab.Body,
                Font = bodyFont,
                ForeColor = Color.FromArgb(169, 172, 180),
                BackColor = Color.Transparent,
                AutoSize = false,
                UseMnemonic = false,
                Cursor = Cursors.Hand,
                Bounds = new Rectangle(contentX, y, contentW, (int)Math.Round(lines * 17 * _scale)),
            };
            label.MouseUp += (s, e) => OpenChat();
            Controls.Add(label);
        }

        private void RebuildBody()
        {
            int pad = (int)Math.Round(16 * _scale);
            int contentX = (int)Math.Round(4 * _scale) + (int)Math.Round(14 * _scale);
            int contentW = _width - contentX - pad;
            BuildTabBody(contentX, BodyTop(), contentW);
            Invalidate();
        }

        /// Y of the question body, below the heading and any tab strip.
        private int BodyTop()
        {
            int y = (int)Math.Round(15 * _scale);
            if (!string.IsNullOrEmpty(_spec.Heading)) y += (int)Math.Round(21 * _scale) + (int)Math.Round(7 * _scale);
            if (_tabs.Count > 1) y += (int)Math.Round(24 * _scale) + (int)Math.Round(10 * _scale);
            return y;
        }

        /// The dismiss affordance, top-right. Without it the only way to get rid
        /// of a card is to click it, which also switches to the chat.
        private RectangleF CloseRect()
        {
            return new RectangleF(_width - 32 * _scale, 9 * _scale, 22 * _scale, 22 * _scale);
        }

        private void DrawClose(Graphics g)
        {
            RectangleF r = CloseRect();
            if (_closeHover)
            {
                using (var brush = new SolidBrush(Color.FromArgb(48, 51, 57)))
                using (GraphicsPath path = Rounded(r, 5f * _scale))
                    g.FillPath(brush, path);
            }
            using (var font = new Font("Segoe UI", 9.5f, FontStyle.Regular, GraphicsUnit.Point))
            using (var fmt = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center })
            using (var brush = new SolidBrush(_closeHover ? Color.FromArgb(235, 236, 240) : Color.FromArgb(128, 133, 142)))
                g.DrawString("\u2715", font, brush, r, fmt);
        }

        private static Color Parse(string hex, Color fallback)
        {
            if (string.IsNullOrEmpty(hex)) return fallback;
            try { return ColorTranslator.FromHtml(hex); } catch { return fallback; }
        }

        private string Shorten(string text, int pixels)
        {
            if (string.IsNullOrEmpty(text)) return "";
            using (var font = new Font("Segoe UI", 8.5f, FontStyle.Regular, GraphicsUnit.Point))
            {
                if (TextRenderer.MeasureText(text, font).Width <= pixels) return text;
                for (int length = text.Length - 1; length > 0; length--)
                {
                    string candidate = text.Substring(0, length).TrimEnd() + "\u2026";
                    if (TextRenderer.MeasureText(candidate, font).Width <= pixels) return candidate;
                }
            }
            return "";
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            try
            {
                using (GraphicsPath path = Rounded(new RectangleF(0, 0, _width, _height), _radius))
                    Region = new Region(path);

                // Publish our height first: the cards above us position themselves
                // from this file, so it must exist before they read the layout.
                if (!string.IsNullOrEmpty(_sizePath))
                {
                    try { File.WriteAllText(_sizePath, _height.ToString(CultureInfo.InvariantCulture)); }
                    catch (Exception sizeEx) { Diag.Write(_spec.LogPath, "size write failed: " + sizeEx.Message); }
                }

                PollLayout();
                SetWindowPos(Handle, HWND_TOPMOST, _startX, _targetY, 0, 0, SWP_NOSIZE | SWP_NOACTIVATE);
                Diag.Write(_spec.LogPath, "showing card id=" + _spec.CardId + " tabs=" + _tabs.Count
                    + " target=" + _targetX + "," + _targetY + " size=" + _width + "x" + _height);
            }
            catch (Exception ex)
            {
                Diag.Write(_spec.LogPath, "setup failed: " + ex.GetType().Name + ": " + ex.Message);
                BeginInvoke(new Action(Close));
                return;
            }
            _tick.Start();
            _poll.Start();
            if (_spec.AutoCloseMs > 0) _autoClose.Start();
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            // Dump here, not in OnHandleCreated: at handle-creation time the child
            // controls do not exist yet, so DrawToBitmap renders a blank card.
            if (string.IsNullOrEmpty(_spec.DumpPng)) return;
            try
            {
                using (var bmp = new Bitmap(_width, _height))
                {
                    DrawToBitmap(bmp, new Rectangle(0, 0, _width, _height));
                    bmp.Save(_spec.DumpPng, System.Drawing.Imaging.ImageFormat.Png);
                }
            }
            catch (Exception dumpEx) { Diag.Write(_spec.LogPath, "dump failed: " + dumpEx.Message); }
        }

        /// Poll the shared layout, and retire if the question was answered in the
        /// chat. The plugin observes the answer because the waterfall resolves
        /// when the chat's own answerer settles it, so the card can step aside
        /// rather than linger next to a question that is already answered.
        private void OnPoll()
        {
            if (!string.IsNullOrEmpty(_closePath))
            {
                try
                {
                    if (File.Exists(_closePath)) { Dismiss("answered in chat"); return; }
                }
                catch { }
            }
            PollLayout();
        }

        /// Read the shared layout, recompute our slot, and manage the countdown.
        private void PollLayout()
        {
            if (string.IsNullOrEmpty(_spec.LayoutPath)) return;
            string[] lines;
            try
            {
                lines = File.ReadAllLines(_spec.LayoutPath);
            }
            catch
            {
                return; // not written yet, or mid-rewrite: keep the current slot
            }

            int index = -1;
            int countdownSeconds = 0;
            for (int i = 0; i < lines.Length; i++)
            {
                string[] parts = lines[i].Split('|');
                if (parts.Length < 2) continue;
                if (parts[0] == _spec.CardId)
                {
                    index = i;
                    int.TryParse(parts[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out countdownSeconds);
                    break;
                }
            }
            if (index < 0) return; // not listed (yet)

            int sum = 0;
            for (int j = 0; j <= index; j++)
            {
                string id = lines[j].Split('|')[0];
                sum += j == index ? _height : HeightOf(id);
            }
            _targetY = _area.Bottom - sum - index * StackGap - (int)Math.Round(EdgeMargin * _scale);

            if (index == 0)
            {
                // Newest card: never counts down. If newer cards were dismissed and
                // we are on top again, stop counting and stay put.
                _counting = false;
                _countdownEnds = DateTime.MinValue;
            }
            else if (!_counting && countdownSeconds > 0)
            {
                _counting = true;
                _countdownTotalMs = countdownSeconds * 1000;
                _countdownEnds = DateTime.UtcNow.AddSeconds(countdownSeconds);
                Diag.Write(_spec.LogPath, "pushed to slot " + index + ", counting down " + countdownSeconds + "s");
            }
        }

        private int HeightOf(string id)
        {
            if (string.IsNullOrEmpty(_sizePath)) return FallbackHeight;
            try
            {
                string path = Path.Combine(Path.GetDirectoryName(_sizePath), id + ".size");
                int parsed;
                if (int.TryParse(File.ReadAllText(path).Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out parsed) && parsed > 0)
                    return parsed;
            }
            catch { }
            return FallbackHeight;
        }

        private void OnTick(object sender, EventArgs e)
        {
            if (_settled || _dismissing) return;

            if (_counting && DateTime.UtcNow >= _countdownEnds)
            {
                Dismiss("countdown");
                return;
            }

            if (_slideT < 1f)
            {
                _slideT = Math.Min(1f, _slideT + 15f / 1000f / 0.26f);
                float eased = 1f - (float)Math.Pow(1f - _slideT, 3);
                Left = (int)Math.Round(_startX + (_targetX - _startX) * eased);
                Top = _targetY;
                if (_slideT >= 1f && !_slideLogged)
                {
                    _slideLogged = true;
                    // Log where the window ACTUALLY ended up, not where it was asked
                    // to go: a card parked off-screen otherwise reports success
                    // everywhere while never being seen.
                    Diag.Write(_spec.LogPath, "slid in, window at " + Left + "," + Top
                        + " (target " + _targetX + "," + _targetY + ")");
                }
                return;
            }

            // Ease toward the slot the layout assigns (a newer card pushed us up).
            if (Top != _targetY)
            {
                int delta = _targetY - Top;
                int step = Math.Max(2, Math.Abs(delta) / 4);
                Top += Math.Sign(delta) * Math.Min(Math.Abs(delta), step);
            }

            if (_counting) Invalidate(); // keep the countdown bar moving
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;

            using (var pen = new Pen(Color.FromArgb(52, 55, 61), 1f * _scale))
            using (GraphicsPath border = Rounded(new RectangleF(0.5f, 0.5f, _width - 1f, _height - 1f), _radius))
                g.DrawPath(pen, border);

            // Accent bar down the left edge, clipped by the rounded Region.
            using (var brush = new SolidBrush(_accent))
                g.FillRectangle(brush, 0, 0, (float)Math.Round(4 * _scale), _height);

            // The countdown bar appears only while this card is counting down, so a
            // card that is simply waiting for you shows no expiry at all.
            if (_counting && _countdownTotalMs > 0)
            {
                double left = (_countdownEnds - DateTime.UtcNow).TotalMilliseconds / _countdownTotalMs;
                float fraction = (float)Math.Max(0.0, Math.Min(1.0, left));
                using (var brush = new SolidBrush(Color.FromArgb(150, _accent)))
                    g.FillRectangle(brush, 0, _height - (float)Math.Round(3 * _scale), _width * fraction, (float)Math.Round(3 * _scale));
            }

            DrawClose(g);
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);
            bool hover = CloseRect().Contains(e.Location);
            if (hover != _closeHover) { _closeHover = hover; Invalidate(); }
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            base.OnMouseUp(e);
            if (_settled) return;
            // The close button dismisses without switching to the chat; anywhere
            // else on the card opens the chat.
            if (CloseRect().Contains(e.Location))
            {
                _settled = true;
                Diag.Write(_spec.LogPath, "closed via the X button");
                Dismiss("closed");
                return;
            }
            OpenChat();
        }

        /// The whole card is one target: bring the chat forward and step aside.
        private void OpenChat()
        {
            if (_settled) return;
            _settled = true;
            Diag.Write(_spec.LogPath, "clicked, opening the chat");
            if (_spec.FocusOnClick) FocusHarness();
            Dismiss("clicked");
        }

        private void Dismiss(string reason)
        {
            if (_dismissing) return;
            _dismissing = true;
            Diag.Write(_spec.LogPath, "dismissed (" + reason + ")");
            _poll.Stop();
            _autoClose.Stop();
            var slideOut = new Timer { Interval = 15 };
            int from = Left;
            int to = _area.Right;
            float t = 0f;
            slideOut.Tick += (s, e) =>
            {
                t = Math.Min(1f, t + 15f / 1000f / 0.18f);
                Left = (int)Math.Round(from + (to - from) * (t * t));
                if (t >= 1f) { slideOut.Stop(); Close(); }
            };
            slideOut.Start();
        }

        private static void FocusHarness()
        {
            try
            {
                Type shellType = Type.GetTypeFromProgID("WScript.Shell");
                if (shellType == null) return;
                object shell = Activator.CreateInstance(shellType);
                shellType.InvokeMember("AppActivate", System.Reflection.BindingFlags.InvokeMethod,
                    null, shell, new object[] { "DeepSeek Harness" });
            }
            catch { }
        }

        private static GraphicsPath Rounded(RectangleF r, float radius)
        {
            var path = new GraphicsPath();
            float d = Math.Min(radius * 2f, Math.Min(r.Width, r.Height));
            if (d <= 1f) { path.AddRectangle(r); return path; }
            path.AddArc(r.X, r.Y, d, d, 180, 90);
            path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }
    }
}
