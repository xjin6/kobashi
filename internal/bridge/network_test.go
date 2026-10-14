package bridge

import (
	"bufio"
	"context"
	"crypto/x509"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"
)

func TestTLSNeverTrustsAnUnverifiedCertificate(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Fatal("untrusted TLS request reached the server") }))
	defer server.Close()
	conn, err := tunnelTLS(context.Background(), server.Listener.Addr().String(), nil, time.Second)
	if conn != nil {
		conn.Close()
		t.Fatal("untrusted certificate accepted")
	}
	var certificate *net.OpError
	var authority x509.UnknownAuthorityError
	if err == nil || !(errors.As(err, &authority) || errors.As(err, &certificate)) {
		t.Fatal("missing TLS verification error", err)
	}
}
func TestHTTPProxyUsesCONNECTWithoutRelaxingTLS(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	target := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Fatal("untrusted TLS request reached target") }))
	defer target.Close()
	done := make(chan error, 1)
	go func() {
		c, err := l.Accept()
		if err != nil {
			done <- err
			return
		}
		defer c.Close()
		_ = c.SetDeadline(time.Now().Add(3 * time.Second))
		reader := bufio.NewReader(c)
		request, err := http.ReadRequest(reader)
		if err != nil {
			done <- err
			return
		}
		if request.Method != "CONNECT" || request.Host != target.Listener.Addr().String() {
			done <- errors.New("invalid CONNECT")
			return
		}
		upstream, err := net.DialTimeout("tcp", request.Host, time.Second)
		if err != nil {
			done <- err
			return
		}
		defer upstream.Close()
		_, err = io.WriteString(c, "HTTP/1.1 200 Connection established\r\n\r\n")
		if err != nil {
			done <- err
			return
		}
		go io.Copy(upstream, reader)
		_, err = io.Copy(c, upstream)
		done <- err
	}()
	proxy, _ := url.Parse("http://" + l.Addr().String())
	conn, err := tunnelTLS(context.Background(), target.Listener.Addr().String(), proxy, time.Second)
	if conn != nil {
		conn.Close()
		t.Fatal("CONNECT bypassed certificate verification")
	}
	var authority x509.UnknownAuthorityError
	if !errors.As(err, &authority) {
		t.Fatal("unexpected TLS failure", err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}
func TestSOCKS5AuthenticationAndTarget(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	done := make(chan error, 1)
	go func() {
		defer server.Close()
		_ = server.SetDeadline(time.Now().Add(time.Second))
		greeting := make([]byte, 4)
		if _, err := io.ReadFull(server, greeting); err != nil {
			done <- err
			return
		}
		if string(greeting) != string([]byte{5, 2, 0, 2}) {
			done <- errors.New("invalid greeting")
			return
		}
		_, _ = server.Write([]byte{5, 2})
		auth := make([]byte, 5)
		if _, err := io.ReadFull(server, auth); err != nil {
			done <- err
			return
		}
		if string(auth) != string([]byte{1, 1, 'u', 1, 'p'}) {
			done <- errors.New("invalid credentials")
			return
		}
		_, _ = server.Write([]byte{1, 0})
		header := make([]byte, 5)
		if _, err := io.ReadFull(server, header); err != nil {
			done <- err
			return
		}
		address := make([]byte, int(header[4])+2)
		if _, err := io.ReadFull(server, address); err != nil {
			done <- err
			return
		}
		if header[3] != 3 || string(address[:len(address)-2]) != "example.invalid" || address[len(address)-2] != 1 || address[len(address)-1] != 187 {
			done <- errors.New("incorrect target")
			return
		}
		_, err := server.Write([]byte{5, 0, 0, 1, 127, 0, 0, 1, 0, 0})
		done <- err
	}()
	proxy, _ := url.Parse("socks5://u:p@127.0.0.1:1080")
	if err := socksConnect(client, "example.invalid:443", proxy); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}
