//go:build windows

package main

import (
	"context"
	"errors"
	"runtime"
	"sync"
	"syscall"
	"unsafe"
)

const (
	trayCallbackMessage = 0x8001
	wmClose             = 0x0010
	wmDestroy           = 0x0002
	wmLButtonUp         = 0x0202
	wmLButtonDouble     = 0x0203
	wmRButtonUp         = 0x0205
	nimAdd              = 0x00000000
	nimDelete           = 0x00000002
	nifMessage          = 0x00000001
	nifIcon             = 0x00000002
	nifTip              = 0x00000004
	mfString            = 0x00000000
	mfSeparator         = 0x00000800
	tpmReturnCommand    = 0x00000100
	tpmRightButton      = 0x00000002
	swShowNormal        = 1
	idiApplication      = 32512
	trayCommandOpen     = 1001
	trayCommandExit     = 1002
)

type trayPoint struct {
	x int32
	y int32
}

type trayMessage struct {
	hwnd    uintptr
	message uint32
	wParam  uintptr
	lParam  uintptr
	time    uint32
	point   trayPoint
	private uint32
}

type trayWindowClass struct {
	cbSize      uint32
	style       uint32
	wndProc     uintptr
	classExtra  int32
	windowExtra int32
	instance    uintptr
	icon        uintptr
	cursor      uintptr
	background  uintptr
	menuName    *uint16
	className   *uint16
	smallIcon   uintptr
}

type trayNotifyIconData struct {
	cbSize          uint32
	hwnd            uintptr
	id              uint32
	flags           uint32
	callbackMessage uint32
	icon            uintptr
	tip             [128]uint16
	state           uint32
	stateMask       uint32
	info            [256]uint16
	version         uint32
	infoTitle       [64]uint16
	infoFlags       uint32
	guidItem        [16]byte
	balloonIcon     uintptr
}

type trayWindowState struct {
	pageURL string
	cancel  context.CancelFunc
}

var (
	trayUser32           = syscall.NewLazyDLL("user32.dll")
	trayShell32          = syscall.NewLazyDLL("shell32.dll")
	trayKernel32         = syscall.NewLazyDLL("kernel32.dll")
	trayRegisterClass    = trayUser32.NewProc("RegisterClassExW")
	trayUnregisterClass  = trayUser32.NewProc("UnregisterClassW")
	trayCreateWindow     = trayUser32.NewProc("CreateWindowExW")
	trayDestroyWindow    = trayUser32.NewProc("DestroyWindow")
	trayDefWindowProc    = trayUser32.NewProc("DefWindowProcW")
	trayGetMessage       = trayUser32.NewProc("GetMessageW")
	trayTranslateMessage = trayUser32.NewProc("TranslateMessage")
	trayDispatchMessage  = trayUser32.NewProc("DispatchMessageW")
	trayPostMessage      = trayUser32.NewProc("PostMessageW")
	trayPostQuitMessage  = trayUser32.NewProc("PostQuitMessage")
	trayLoadIcon         = trayUser32.NewProc("LoadIconW")
	trayCreatePopupMenu  = trayUser32.NewProc("CreatePopupMenu")
	trayAppendMenu       = trayUser32.NewProc("AppendMenuW")
	trayTrackPopupMenu   = trayUser32.NewProc("TrackPopupMenu")
	trayDestroyMenu      = trayUser32.NewProc("DestroyMenu")
	trayGetCursorPos     = trayUser32.NewProc("GetCursorPos")
	traySetForeground    = trayUser32.NewProc("SetForegroundWindow")
	trayShellNotifyIcon  = trayShell32.NewProc("Shell_NotifyIconW")
	trayShellExecute     = trayShell32.NewProc("ShellExecuteW")
	trayGetModuleHandle  = trayKernel32.NewProc("GetModuleHandleW")
	trayWindowProcedure  = syscall.NewCallback(trayWindowProc)
	trayStates           sync.Map
)

func startPlatformTray(
	ctx context.Context,
	cancel context.CancelFunc,
	pageURL string,
	openOnStart bool,
) error {
	if cancel == nil || pageURL == "" {
		return errors.New("tray configuration is unavailable")
	}
	ready := make(chan error, 1)
	go runTray(ctx, cancel, pageURL, openOnStart, ready)
	return <-ready
}

func runTray(
	ctx context.Context,
	cancel context.CancelFunc,
	pageURL string,
	openOnStart bool,
	ready chan<- error,
) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	className, _ := syscall.UTF16PtrFromString("LongHubManagerTrayWindowV2")
	instance, _, _ := trayGetModuleHandle.Call(0)
	windowClass := trayWindowClass{
		cbSize:    uint32(unsafe.Sizeof(trayWindowClass{})),
		wndProc:   trayWindowProcedure,
		instance:  instance,
		className: className,
	}
	registered, _, _ := trayRegisterClass.Call(uintptr(unsafe.Pointer(&windowClass)))
	if registered == 0 {
		ready <- errors.New("tray class registration failed")
		return
	}
	defer trayUnregisterClass.Call(uintptr(unsafe.Pointer(className)), instance)
	windowName, _ := syscall.UTF16PtrFromString("LongHub Manager")
	hwnd, _, _ := trayCreateWindow.Call(
		0,
		uintptr(unsafe.Pointer(className)),
		uintptr(unsafe.Pointer(windowName)),
		0, 0, 0, 0, 0, 0, 0, instance, 0,
	)
	if hwnd == 0 {
		ready <- errors.New("tray window creation failed")
		return
	}
	state := &trayWindowState{pageURL: pageURL, cancel: cancel}
	trayStates.Store(hwnd, state)
	defer trayStates.Delete(hwnd)
	icon, _, _ := trayLoadIcon.Call(0, idiApplication)
	notify := trayNotifyIconData{
		cbSize:          uint32(unsafe.Sizeof(trayNotifyIconData{})),
		hwnd:            hwnd,
		id:              1,
		flags:           nifMessage | nifIcon | nifTip,
		callbackMessage: trayCallbackMessage,
		icon:            icon,
	}
	copy(notify.tip[:], syscall.StringToUTF16("LongHub Manager"))
	added, _, _ := trayShellNotifyIcon.Call(nimAdd, uintptr(unsafe.Pointer(&notify)))
	if added == 0 {
		trayDestroyWindow.Call(hwnd)
		ready <- errors.New("tray icon creation failed")
		return
	}
	defer trayShellNotifyIcon.Call(nimDelete, uintptr(unsafe.Pointer(&notify)))
	ready <- nil
	if openOnStart {
		openTrayPage(pageURL)
	}
	go func() {
		<-ctx.Done()
		trayPostMessage.Call(hwnd, wmClose, 0, 0)
	}()
	var message trayMessage
	for {
		result, _, _ := trayGetMessage.Call(uintptr(unsafe.Pointer(&message)), 0, 0, 0)
		if int32(result) <= 0 {
			break
		}
		trayTranslateMessage.Call(uintptr(unsafe.Pointer(&message)))
		trayDispatchMessage.Call(uintptr(unsafe.Pointer(&message)))
	}
}

func trayWindowProc(hwnd uintptr, message uint32, wParam, lParam uintptr) uintptr {
	switch message {
	case trayCallbackMessage:
		value, ok := trayStates.Load(hwnd)
		if !ok {
			return 0
		}
		state := value.(*trayWindowState)
		switch uint32(lParam) {
		case wmLButtonUp, wmLButtonDouble:
			openTrayPage(state.pageURL)
		case wmRButtonUp:
			command := trayMenuCommand(hwnd)
			switch command {
			case trayCommandOpen:
				openTrayPage(state.pageURL)
			case trayCommandExit:
				state.cancel()
				trayDestroyWindow.Call(hwnd)
			}
		}
		return 0
	case wmClose:
		trayDestroyWindow.Call(hwnd)
		return 0
	case wmDestroy:
		trayPostQuitMessage.Call(0)
		return 0
	default:
		result, _, _ := trayDefWindowProc.Call(hwnd, uintptr(message), wParam, lParam)
		return result
	}
}

func trayMenuCommand(hwnd uintptr) uint32 {
	menu, _, _ := trayCreatePopupMenu.Call()
	if menu == 0 {
		return 0
	}
	defer trayDestroyMenu.Call(menu)
	openLabel, _ := syscall.UTF16PtrFromString("打开 LongHub")
	exitLabel, _ := syscall.UTF16PtrFromString("退出")
	trayAppendMenu.Call(menu, mfString, trayCommandOpen, uintptr(unsafe.Pointer(openLabel)))
	trayAppendMenu.Call(menu, mfSeparator, 0, 0)
	trayAppendMenu.Call(menu, mfString, trayCommandExit, uintptr(unsafe.Pointer(exitLabel)))
	var point trayPoint
	trayGetCursorPos.Call(uintptr(unsafe.Pointer(&point)))
	traySetForeground.Call(hwnd)
	command, _, _ := trayTrackPopupMenu.Call(
		menu,
		tpmReturnCommand|tpmRightButton,
		uintptr(point.x),
		uintptr(point.y),
		0,
		hwnd,
		0,
	)
	return uint32(command)
}

func openTrayPage(pageURL string) {
	operation, _ := syscall.UTF16PtrFromString("open")
	target, err := syscall.UTF16PtrFromString(pageURL)
	if err != nil {
		return
	}
	trayShellExecute.Call(
		0,
		uintptr(unsafe.Pointer(operation)),
		uintptr(unsafe.Pointer(target)),
		0,
		0,
		swShowNormal,
	)
}
