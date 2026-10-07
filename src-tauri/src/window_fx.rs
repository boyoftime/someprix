//! Custom window transitions.
//!
//! Windows' own minimize/maximize/restore animations are switched off for the main window so the
//! frontend can play its own. Requests that come from the system (taskbar button, system menu,
//! keyboard shortcuts) are held back and forwarded to the frontend as a `window-fx://request`
//! event; the frontend animates and then performs the action itself.

use tauri::WebviewWindow;

/// Called by the frontend once it is listening for requests. Until then, system requests pass
/// straight through so the window never gets stuck if the frontend fails to load.
#[tauri::command]
pub fn window_fx_ready() {
    #[cfg(windows)]
    imp::READY.store(true, std::sync::atomic::Ordering::Relaxed);
}

/// The rect the window returns to when un-maximized, as `[x, y, width, height]` in physical
/// screen pixels. Restore-down animates toward it before the window actually snaps there.
#[tauri::command]
pub fn window_fx_normal_rect(window: WebviewWindow) -> Option<[i32; 4]> {
    #[cfg(windows)]
    return imp::normal_rect(&window);
    #[cfg(not(windows))]
    {
        let _ = window;
        None
    }
}

/// Covers the window's monitor with a still screenshot, so a maximize / unmaximize snap
/// underneath can't flash. The frontend thaws it once the app has redrawn in place; it also
/// thaws itself after a moment in case that never happens.
#[tauri::command]
pub fn window_fx_freeze(window: WebviewWindow) {
    #[cfg(windows)]
    imp::freeze(&window);
    #[cfg(not(windows))]
    let _ = window;
}

#[tauri::command]
pub fn window_fx_thaw() {
    #[cfg(windows)]
    imp::thaw();
}

pub fn install(window: &WebviewWindow) {
    #[cfg(windows)]
    imp::install(window);
    #[cfg(not(windows))]
    let _ = window;
}

#[cfg(windows)]
mod imp {
    use std::{
        ffi::c_void,
        sync::{
            atomic::{AtomicBool, AtomicIsize, AtomicU64, Ordering},
            Once, OnceLock,
        },
        time::Duration,
    };

    use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
    use windows::{
        core::{w, PCWSTR},
        Win32::{
            Foundation::{COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, POINT, RECT, SIZE, WPARAM},
            Graphics::{
                Dwm::{DwmFlush, DwmSetWindowAttribute, DWMWA_TRANSITIONS_FORCEDISABLED},
                Gdi::{
                    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject,
                    GetDC, GetMonitorInfoW, MonitorFromRect, MonitorFromWindow, ReleaseDC,
                    SelectObject, AC_SRC_OVER, BLENDFUNCTION, MONITORINFO,
                    MONITOR_DEFAULTTONEAREST, SRCCOPY,
                },
            },
            System::LibraryLoader::GetModuleHandleW,
            UI::{
                Shell::{DefSubclassProc, SetWindowSubclass},
                WindowsAndMessaging::{
                    CreateWindowExW, DefWindowProcW, DestroyWindow, GetWindowPlacement, IsIconic,
                    IsZoomed, RegisterClassExW, ShowWindow, UpdateLayeredWindow, SC_MAXIMIZE,
                    SC_MINIMIZE, SC_RESTORE, SW_SHOWNOACTIVATE, ULW_ALPHA, WINDOWPLACEMENT,
                    WM_SYSCOMMAND, WNDCLASSEXW, WS_EX_LAYERED, WS_EX_NOACTIVATE,
                    WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_EX_TRANSPARENT, WS_POPUP,
                },
            },
        },
    };

    pub static READY: AtomicBool = AtomicBool::new(false);
    static APP: OnceLock<AppHandle> = OnceLock::new();

    const SUBCLASS_ID: usize = 0x5350_5258;
    const REQUEST_EVENT: &str = "window-fx://request";

    /// The screenshot overlay currently shown, as a raw HWND (0 when none).
    static OVERLAY: AtomicIsize = AtomicIsize::new(0);
    /// Bumped on every freeze so a stale safety timer can't lift a newer screenshot.
    static FREEZE_GENERATION: AtomicU64 = AtomicU64::new(0);
    const THAW_AFTER: Duration = Duration::from_millis(700);
    const OVERLAY_CLASS: PCWSTR = w!("SomeprixFreezeOverlay");

    pub fn install(window: &WebviewWindow) {
        let Ok(hwnd) = window.hwnd() else { return };
        let _ = APP.set(window.app_handle().clone());

        let disabled: i32 = 1;
        unsafe {
            let _ = DwmSetWindowAttribute(
                hwnd,
                DWMWA_TRANSITIONS_FORCEDISABLED,
                &disabled as *const i32 as *const c_void,
                size_of::<i32>() as u32,
            );
            let _ = SetWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID, 0);
        }
    }

    pub fn normal_rect(window: &WebviewWindow) -> Option<[i32; 4]> {
        let hwnd = window.hwnd().ok()?;
        let mut placement = WINDOWPLACEMENT {
            length: size_of::<WINDOWPLACEMENT>() as u32,
            ..Default::default()
        };
        unsafe { GetWindowPlacement(hwnd, &mut placement) }.ok()?;
        let r = placement.rcNormalPosition;

        // The placement is in workspace coordinates, which are offset from screen coordinates by
        // any taskbar docked at the top or left of the monitor.
        let mut info = MONITORINFO {
            cbSize: size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        let monitor = unsafe { MonitorFromRect(&r, MONITOR_DEFAULTTONEAREST) };
        let (dx, dy) = if unsafe { GetMonitorInfoW(monitor, &mut info) }.as_bool() {
            (info.rcWork.left - info.rcMonitor.left, info.rcWork.top - info.rcMonitor.top)
        } else {
            (0, 0)
        };
        Some([r.left + dx, r.top + dy, r.right - r.left, r.bottom - r.top])
    }

    pub fn freeze(window: &WebviewWindow) {
        thaw();
        let Ok(hwnd) = window.hwnd() else { return };
        let Some(area) = work_area(hwnd) else { return };
        let Some(overlay) = (unsafe { show_screenshot(area) }) else { return };
        OVERLAY.store(overlay.0 as isize, Ordering::SeqCst);

        let generation = FREEZE_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
        let app = window.app_handle().clone();
        std::thread::spawn(move || {
            std::thread::sleep(THAW_AFTER);
            let _ = app.run_on_main_thread(move || {
                if FREEZE_GENERATION.load(Ordering::SeqCst) == generation {
                    thaw();
                }
            });
        });
    }

    pub fn thaw() {
        let overlay = OVERLAY.swap(0, Ordering::SeqCst);
        if overlay != 0 {
            unsafe {
                let _ = DestroyWindow(HWND(overlay as *mut c_void));
            }
        }
    }

    fn work_area(hwnd: HWND) -> Option<RECT> {
        let mut info = MONITORINFO {
            cbSize: size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        let monitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
        unsafe { GetMonitorInfoW(monitor, &mut info) }
            .as_bool()
            .then_some(info.rcWork)
    }

    /// Copies `area` of the screen into a click-through, top-most window placed exactly over it.
    unsafe fn show_screenshot(area: RECT) -> Option<HWND> {
        let (x, y) = (area.left, area.top);
        let (w, h) = (area.right - area.left, area.bottom - area.top);
        let instance = GetModuleHandleW(None).ok().map(|module| HINSTANCE(module.0));

        static REGISTER: Once = Once::new();
        REGISTER.call_once(|| {
            let class = WNDCLASSEXW {
                cbSize: size_of::<WNDCLASSEXW>() as u32,
                lpfnWndProc: Some(overlay_proc),
                hInstance: instance.unwrap_or_default(),
                lpszClassName: OVERLAY_CLASS,
                ..Default::default()
            };
            RegisterClassExW(&class);
        });

        let overlay = CreateWindowExW(
            WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
            OVERLAY_CLASS,
            w!(""),
            WS_POPUP,
            x,
            y,
            w,
            h,
            None,
            None,
            instance,
            None,
        )
        .ok()?;

        let screen = GetDC(None);
        let memory = CreateCompatibleDC(Some(screen));
        let bitmap = CreateCompatibleBitmap(screen, w, h);
        let previous = SelectObject(memory, bitmap.into());
        let blend = BLENDFUNCTION {
            BlendOp: AC_SRC_OVER as u8,
            BlendFlags: 0,
            SourceConstantAlpha: 255,
            AlphaFormat: 0,
        };
        let shown = BitBlt(memory, 0, 0, w, h, Some(screen), x, y, SRCCOPY).is_ok()
            && UpdateLayeredWindow(
                overlay,
                Some(screen),
                Some(&POINT { x, y } as *const POINT),
                Some(&SIZE { cx: w, cy: h } as *const SIZE),
                Some(memory),
                Some(&POINT::default() as *const POINT),
                COLORREF(0),
                Some(&blend as *const BLENDFUNCTION),
                ULW_ALPHA,
            )
            .is_ok();
        SelectObject(memory, previous);
        let _ = DeleteObject(bitmap.into());
        let _ = DeleteDC(memory);
        ReleaseDC(None, screen);

        if !shown {
            let _ = DestroyWindow(overlay);
            return None;
        }
        let _ = ShowWindow(overlay, SW_SHOWNOACTIVATE);
        // Don't let anything move underneath until the screenshot is actually on screen.
        let _ = DwmFlush();
        Some(overlay)
    }

    unsafe extern "system" fn overlay_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }

    unsafe extern "system" fn subclass_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _id: usize,
        _data: usize,
    ) -> LRESULT {
        if msg == WM_SYSCOMMAND && READY.load(Ordering::Relaxed) {
            if let Some(request) = request_for(hwnd, (wparam.0 & 0xFFF0) as u32) {
                if let Some(app) = APP.get() {
                    let _ = app.emit_to("main", REQUEST_EVENT, request);
                }
                return LRESULT(0);
            }
        }
        DefSubclassProc(hwnd, msg, wparam, lparam)
    }

    fn request_for(hwnd: HWND, command: u32) -> Option<&'static str> {
        let (minimized, maximized) = unsafe { (IsIconic(hwnd).as_bool(), IsZoomed(hwnd).as_bool()) };
        match command {
            SC_MINIMIZE if !minimized => Some("minimize"),
            SC_MAXIMIZE if !minimized && !maximized => Some("maximize"),
            // Restoring from the taskbar is left to Windows; the frontend animates once it's back.
            SC_RESTORE if !minimized && maximized => Some("restore"),
            _ => None,
        }
    }
}
