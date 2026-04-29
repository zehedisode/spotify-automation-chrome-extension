Chrome için kullanıma hazır bir tarayıcı eklentisi geliştirmeni istiyorum.

Amacım:
Bilgisayarda uzun süre vakit geçiriyorum ve Spotify Web üzerinden müzik dinliyorum. YouTube, Netflix, Twitter/X, Instagram, TikTok veya başka bir sitede video açtığımda Spotify müziğinin otomatik durmasını; videoyu duraklattığımda veya kapattığımda Spotify’ın kaldığı yerden otomatik devam etmesini istiyorum.

Eklenti şu özelliklere sahip olsun:

1. Spotify Web kontrolü
- Tarayıcı açıldığında Spotify Web otomatik açılsın.
- Önceden ayarlayabileceğim bir Spotify çalma listesi otomatik başlatılsın.
- Spotify sekmesi zaten açıksa yeni sekme açmasın, mevcut sekmeyi kullansın.
- Müzik çalıyorsa gereksiz tekrar başlatma yapmasın.
- Ses seviyesi çok yüksekse, çalmadan önce belirlediğim maksimum seviyeye otomatik kıssın.

2. Video algılama ve senkronizasyon
- Chrome’da herhangi bir sekmede video oynatıldığında Spotify otomatik duraklasın.
- Video duraklatıldığında, kapatıldığında veya sekmeden çıkıldığında Spotify otomatik devam etsin.
- Birden fazla video sekmesi varsa Spotify yalnızca hiçbir video çalmıyorsa devam etsin.
- YouTube başta olmak üzere yaygın video sitelerinde çalışsın.
- HTML5 video elementlerini algılasın.
- Gereksiz tetiklemeleri önlemek için güvenilir bir durum kontrol sistemi olsun.

3. Kullanıcı ayarları
- Eklenti popup ekranı olsun.
- Kullanıcı buradan:
  - Spotify çalma listesi URL’si girebilsin.
  - Maksimum Spotify ses seviyesini ayarlayabilsin.
  - Otomatik başlatmayı açıp kapatabilsin.
  - Video oynayınca Spotify’ı durdurma özelliğini açıp kapatabilsin.
  - Spotify sekmesini otomatik açma özelliğini açıp kapatabilsin.
- Ayarlar chrome.storage ile saklansın.

4. Teknik yapı
- Chrome Manifest V3 kullan.
- Dosya yapısı Chrome’a “Load unpacked” ile direkt yüklenebilir olsun.
- Gereken tüm dosyaları oluştur:
  - manifest.json
  - background.js
  - content.js
  - spotifyController.js veya benzeri
  - popup.html
  - popup.js
  - popup.css
  - varsa icon dosyaları için placeholder çözümü
- Kodlar temiz, yorumlu ve geliştirilebilir olsun.
- Gereksiz harici bağımlılık kullanma.
- Mümkün olduğunca vanilla JavaScript kullan.

5. Önemli davranışlar
- Spotify sadece eklenti tarafından durdurulduysa video bitince geri başlasın. Kullanıcı Spotify’ı manuel durdurduysa otomatik başlatmasın.
- Kullanıcı video izlerken Spotify tekrar başlamasın.
- Spotify sekmesi kapatılırsa eklenti bunu algılasın.
- Tarayıcı yeniden açıldığında ayarlara göre Spotify sekmesini açsın.
- Eklenti hata durumlarında sessizce bozulmasın; console’da anlaşılır loglar versin.

6. Teslimat
- Önce kısa bir proje planı çıkar.
- Sonra tüm dosyaların tam kodlarını üret.
- En sonunda kurulumu anlat:
  1. Dosyaları bir klasöre koyma
  2. chrome://extensions sayfasını açma
  3. Developer Mode açma
  4. Load unpacked ile klasörü yükleme
  5. Spotify Web’e giriş yapma
  6. Eklentiyi test etme

Not:
Ben oluşturduğun dosyaları indirip Chrome’a yükleyerek kullanacağım. Bu yüzden kodlar eksiksiz, çalıştırılabilir ve klasör yapısı net olmalı.