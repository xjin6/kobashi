package bridge

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

type upstreamRoute struct {
	mu    sync.Mutex
	local *url.URL
	at    time.Time
}

func newHTTPClient() *http.Client {
	route := &upstreamRoute{}
	tr := &http.Transport{
		DialTLSContext: route.dialTLS,
		DialContext:    (&net.Dialer{Timeout: 8 * time.Second, KeepAlive: 15 * time.Second}).DialContext,
		MaxIdleConns:   32, MaxIdleConnsPerHost: 8, IdleConnTimeout: 90 * time.Second,
		ResponseHeaderTimeout: 0, ForceAttemptHTTP2: false,
	}
	return &http.Client{Transport: tr}
}
func configuredProxy() (*url.URL, error) {
	for _, key := range []string{"HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"} {
		if value := os.Getenv(key); value != "" {
			if !strings.Contains(value, "://") {
				value = "http://" + value
			}
			u, err := url.Parse(value)
			if err != nil || u.Hostname() == "" {
				return nil, fmt.Errorf("invalid %s proxy", key)
			}
			if !contains([]string{"http", "https", "socks5", "socks5h"}, u.Scheme) {
				return nil, fmt.Errorf("unsupported proxy scheme: %s", u.Scheme)
			}
			return u, nil
		}
	}
	return systemProxy()
}
func (r *upstreamRoute) dialTLS(ctx context.Context, network, address string) (net.Conn, error) {
	proxy, err := configuredProxy()
	if err != nil {
		return nil, err
	}
	if proxy != nil {
		return tunnelTLS(ctx, address, proxy, 8*time.Second)
	}
	r.mu.Lock()
	local, at := r.local, r.at
	r.mu.Unlock()
	if local != nil && time.Since(at) < time.Minute {
		conn, e := tunnelTLS(ctx, address, local, 8*time.Second)
		if e == nil {
			return conn, nil
		}
		r.mu.Lock()
		if r.local == local {
			r.local = nil
		}
		r.mu.Unlock()
	}
	direct, err := tunnelTLS(ctx, address, nil, 2500*time.Millisecond)
	if err == nil {
		return direct, nil
	}
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	// Every candidate is checked with normal certificate verification.
	candidates := []string{"http://127.0.0.1:7890", "http://127.0.0.1:7897", "http://127.0.0.1:1089", "http://127.0.0.1:1087", "http://127.0.0.1:8080", "socks5://127.0.0.1:1080", "socks5://127.0.0.1:7891", "socks5://127.0.0.1:1086"}
	type result struct {
		proxy *url.URL
		conn  net.Conn
		err   error
	}
	results := make(chan result, len(candidates))
	probeCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	for _, value := range candidates {
		p, _ := url.Parse(value)
		go func() { c, e := tunnelTLS(probeCtx, address, p, 2*time.Second); results <- result{p, c, e} }()
	}
	var found *url.URL
	var connection net.Conn
	for range candidates {
		value := <-results
		if value.err == nil && connection == nil {
			found, connection = value.proxy, value.conn
			cancel()
		} else if value.conn != nil {
			value.conn.Close()
		}
	}
	if connection == nil {
		return nil, err
	}
	r.mu.Lock()
	r.local, r.at = found, time.Now()
	r.mu.Unlock()
	log.Printf("Using local proxy %s://%s", found.Scheme, found.Host)
	return connection, nil
}
func tunnelTLS(ctx context.Context, address string, proxy *url.URL, timeout time.Duration) (net.Conn, error) {
	bounded, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	target := address
	if proxy != nil {
		target = proxy.Host
		if proxy.Port() == "" {
			if proxy.Scheme == "https" {
				target = net.JoinHostPort(proxy.Hostname(), "443")
			} else if strings.HasPrefix(proxy.Scheme, "socks5") {
				target = net.JoinHostPort(proxy.Hostname(), "1080")
			} else {
				target = net.JoinHostPort(proxy.Hostname(), "80")
			}
		}
	}
	conn, err := (&net.Dialer{KeepAlive: 15 * time.Second}).DialContext(bounded, "tcp", target)
	if err != nil {
		return nil, err
	}
	ok := false
	defer func() {
		if !ok {
			conn.Close()
		}
	}()
	deadline, _ := bounded.Deadline()
	if err = conn.SetDeadline(deadline); err != nil {
		return nil, err
	}
	if proxy != nil && proxy.Scheme == "https" {
		t := tls.Client(conn, &tls.Config{ServerName: proxy.Hostname(), MinVersion: tls.VersionTLS12})
		if err = t.HandshakeContext(bounded); err != nil {
			return nil, err
		}
		conn = t
	}
	if proxy != nil {
		if strings.HasPrefix(proxy.Scheme, "socks5") {
			if err = socksConnect(conn, address, proxy); err != nil {
				return nil, err
			}
		} else {
			headers := "CONNECT " + address + " HTTP/1.1\r\nHost: " + address + "\r\n"
			if proxy.User != nil {
				password, _ := proxy.User.Password()
				headers += "Proxy-Authorization: Basic " + base64.StdEncoding.EncodeToString([]byte(proxy.User.Username()+":"+password)) + "\r\n"
			}
			if _, err = io.WriteString(conn, headers+"\r\n"); err != nil {
				return nil, err
			}
			reader := bufio.NewReader(conn)
			response, e := http.ReadResponse(reader, &http.Request{Method: "CONNECT"})
			if e != nil {
				return nil, e
			}
			if response.StatusCode != 200 {
				return nil, fmt.Errorf("proxy CONNECT returned %d", response.StatusCode)
			}
			if reader.Buffered() != 0 {
				return nil, errors.New("unexpected data following CONNECT")
			}
		}
	}
	secure := tls.Client(conn, &tls.Config{ServerName: host, MinVersion: tls.VersionTLS12})
	if err = secure.HandshakeContext(bounded); err != nil {
		return nil, err
	}
	if err = secure.SetDeadline(time.Time{}); err != nil {
		return nil, err
	}
	ok = true
	return secure, nil
}
func socksConnect(c net.Conn, address string, p *url.URL) error {
	methods := []byte{5, 1, 0}
	if p.User != nil {
		methods = []byte{5, 2, 0, 2}
	}
	if _, err := c.Write(methods); err != nil {
		return err
	}
	reply := make([]byte, 2)
	if _, err := io.ReadFull(c, reply); err != nil {
		return err
	}
	if reply[0] != 5 {
		return errors.New("invalid SOCKS5 handshake")
	}
	if reply[1] == 2 && p.User != nil {
		user := p.User.Username()
		password, _ := p.User.Password()
		if len(user) > 255 || len(password) > 255 {
			return errors.New("SOCKS5 credentials too long")
		}
		msg := append([]byte{1, byte(len(user))}, []byte(user)...)
		msg = append(msg, byte(len(password)))
		msg = append(msg, []byte(password)...)
		if _, err := c.Write(msg); err != nil {
			return err
		}
		if _, err := io.ReadFull(c, reply); err != nil {
			return err
		}
		if reply[0] != 1 || reply[1] != 0 {
			return errors.New("SOCKS5 authentication rejected")
		}
	} else if reply[1] != 0 {
		return errors.New("SOCKS5 authentication unavailable")
	}
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return err
	}
	var n int
	if _, err = fmt.Sscanf(port, "%d", &n); err != nil || n < 1 || n > 65535 || len(host) > 255 {
		return errors.New("invalid SOCKS5 target")
	}
	msg := append([]byte{5, 1, 0, 3, byte(len(host))}, []byte(host)...)
	msg = append(msg, byte(n>>8), byte(n))
	if _, err = c.Write(msg); err != nil {
		return err
	}
	header := make([]byte, 4)
	if _, err = io.ReadFull(c, header); err != nil {
		return err
	}
	if header[0] != 5 || header[1] != 0 {
		return fmt.Errorf("SOCKS5 connect rejected: %d", header[1])
	}
	length := 0
	switch header[3] {
	case 1:
		length = 4
	case 4:
		length = 16
	case 3:
		b := []byte{0}
		if _, err = io.ReadFull(c, b); err != nil {
			return err
		}
		length = int(b[0])
	default:
		return errors.New("invalid SOCKS5 address")
	}
	_, err = io.CopyN(io.Discard, c, int64(length+2))
	return err
}
