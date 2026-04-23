# DPG-Video-Viewer_1

Тестовая модульная версия приложения для безопасной проверки до релиза.

## Что изменено

- исходный монолитный `index.html` не тронут в `main`
- новая версия вынесена в отдельную папку `DPG-Video-Viewer_1`
- HTML, CSS и JavaScript разделены по файлам
- логика Three.js вынесена в отдельный модуль `src/viewer.js`
- UI и работа с DOM вынесены из одного файла
- добавлен отдельный preview-поток для тестирования через GitHub Pages

## Структура

```text
DPG-Video-Viewer_1/
  index.html
  styles/
    main.css
  src/
    main.js
    viewer.js
```

## Как проверить локально

Вариант 1:
- открыть репозиторий в VS Code
- установить расширение Live Server
- открыть `DPG-Video-Viewer_1/index.html`
- нажать `Open with Live Server`

Вариант 2:
- перейти в папку проекта
- запустить любой локальный статический сервер
- пример для Python:

```bash
cd DPG-Video-Viewer_1
python -m http.server 5500
```

После этого открыть в браузере:

```text
http://localhost:5500
```

## Как включить тестовую ссылку через GitHub Pages

1. Открой репозиторий `Nchernyshev77/DPG-Video-Viewer`
2. Перейди в `Settings`
3. Открой раздел `Pages`
4. В блоке `Build and deployment` выбери:
   - `Source` -> `Deploy from a branch`
5. В выпадающем списке branch выбери:
   - `preview/dpg-video-viewer_1`
6. В выпадающем списке folder выбери:
   - `/ (root)`
7. Нажми `Save`
8. Дождись публикации

После публикации тестовая версия будет доступна по адресу вида:

```text
https://nchernyshev77.github.io/DPG-Video-Viewer/DPG-Video-Viewer_1/
```

## Как перевести в релиз

После тестирования:
- либо открыть Pull Request из `preview/dpg-video-viewer_1` в `main`
- либо вручную перенести содержимое из папки `DPG-Video-Viewer_1` в корень проекта, если захочешь полностью заменить старую версию

Рекомендуемый вариант:
- сначала проверить preview-версию по ссылке
- затем сравнить с текущим `main`
- потом только переносить изменения в прод
